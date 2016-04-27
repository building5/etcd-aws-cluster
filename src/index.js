// Copyright (c) 2016, David M. Lee, II

import 'babel-polyfill';

import AWS from 'aws-sdk';
import _ from 'lodash';
import fetch from 'node-fetch';

const config = {
  client: {
    port: 2379,
    scheme: 'http',
  },
  peer: {
    port: 2380,
    scheme: 'http',
  },
};

process.on('exit', code => {
  // make sure that if we exit with an error, the script we output also errors
  if (code !== 0) {
    console.log('false');
  }
});

const metadata = new AWS.MetadataService();

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const go = async function go() {
  console.error('Loading instance metadata');
  const document = await new Promise((resolve, reject) => {
    metadata.request('/latest/dynamic/instance-identity/document', (err, d) => {
      if (err) {
        return reject(err);
      }
      return resolve(JSON.parse(d));
    });
  });

  const region = document.region;
  const instanceId = document.instanceId;
  const instanceIp = document.privateIp;
  // advertise the instance private address
  const myPeerUrl = `${config.peer.scheme}://${instanceIp}:${config.peer.port}`;
  const myClientUrl = `${config.client.scheme}://${instanceIp}:${config.client.port}`;
  // listen on the any address, so it can be reached on localhost
  const myPeerListenUrl = `${config.peer.scheme}://0.0.0.0:${config.peer.port}`;
  const myClientListenUrl = `${config.client.scheme}://0.0.0.0:${config.client.port}`;

  console.log(`ETCD_NAME=${instanceId}`);
  console.log(`ETCD_LISTEN_PEER_URLS=${myPeerListenUrl}`);
  console.log(`ETCD_LISTEN_CLIENT_URLS=${myClientListenUrl}`);
  console.log(`ETCD_INITIAL_ADVERTISE_PEER_URLS=${myPeerUrl}`);
  console.log(`ETCD_ADVERTISE_CLIENT_URLS=${myClientUrl}`);

  const autoscaling = new AWS.AutoScaling({
    apiVersion: '2011-01-01',
    region,
  });

  const ec2 = new AWS.EC2({
    apiVersion: '2015-10-01',
    region,
  });

  console.error('Finding ASG for', instanceId);
  const { AutoScalingInstances } =
    await autoscaling.describeAutoScalingInstances({ InstanceIds: [instanceId] }).promise();

  if (_.isEmpty(AutoScalingInstances)) {
    fail('Not a member of an auto scaling group');
  }
  const asgName = AutoScalingInstances[0].AutoScalingGroupName;

  console.error('Finding instances in', asgName);
  const { AutoScalingGroups } =
    await autoscaling.describeAutoScalingGroups({ AutoScalingGroupNames: [asgName] }).promise();
  const asgInstanceIds = _(AutoScalingGroups[0].Instances)
    .filter(p => p.LifecycleState === 'InService')
    .map('InstanceId')
    .valueOf();

  if (_.isEmpty(asgInstanceIds)) {
    fail('Unable to find members of auto scaling group');
  }

  const { Reservations } =
    await ec2.describeInstances({ InstanceIds: asgInstanceIds }).promise();
  const asgInstances = _(Reservations).flatMap('Instances').map(instance => {
    const privateIp = _(instance.NetworkInterfaces).flatMap('PrivateIpAddress').valueOf();

    if (!privateIp) {
      fail(`Peer does not yet have private IP ${instance.InstanceId}`);
    }

    const clientURL = `${config.client.scheme}://${privateIp}:${config.client.port}`;
    const peerURL = `${config.peer.scheme}://${privateIp}:${config.peer.port}`;

    return { instanceId: instance.InstanceId, clientURL, peerURL };
  }).valueOf();
  console.error('Found peers in ASG', JSON.stringify(asgInstances, null, 2));

  // walk through the peers to see if any of them have a members list
  const currentCluster = await _.reduce(_.map(asgInstances, 'clientURL'), async(_prior, client) => {
    const prior = await _prior;
    if (prior) {
      return prior;
    }

    const url = `${client}/v2/members`;
    try {
      console.error('Trying', url);
      const res = await fetch(url);

      if (res.status !== 200) {
        console.error('  got', res.status);
        return null;
      }

      const body = await res.json();
      return { memberUrl: url, members: body.members };
    } catch (err) {
      // it's okay if we can't reach a peer, b/c that usually just means that we're
      // bootstrapping the cluster
      console.error('  err', err.message);
      return null;
    }
  }, null);

  if (_.isEmpty(currentCluster)) {
    console.error('Creating new cluster');

    // base the cluster off of the contents of the ASG
    const cluster = _.map(asgInstances, p => `${p.instanceId}=${p.peerURL}`);

    console.log('ETCD_INITIAL_CLUSTER_STATE=new');
    console.log(`ETCD_INITIAL_CLUSTER=${cluster}`);
  } else {
    const memberUrl = currentCluster.memberUrl;
    let members = currentCluster.members;

    // process documented at https://coreos.com/etcd/docs/latest/runtime-configuration.html#add-a-new-member
    console.error('memberUrl', memberUrl);

    // If we're already in the cluster, we could get a 500 back if the cluster has lost quorum
    // waiting on us to join. Best case is that we would get back a 409, anyways.
    const alreadyJoined = _.find(members, m => _.includes(m.peerURLs, myPeerUrl));
    if (alreadyJoined) {
      console.error(`Already in cluster with id ${alreadyJoined.id}`);

      // if we were added to the cluster, but didn't actually start etcd, then it wouldn't have
      // learned our name. Go ahead and set it to what we expect it to be.
      alreadyJoined.name = instanceId;
    } else {
      // If we don't clean up old instances before joining, we run the risk of causing the cluster
      // to lose quorum.
      const [goodMembers, badMembers] =
        _.partition(members, m => _.includes(asgInstanceIds, m.name));
      for (const member of badMembers) {
        console.error('Removing bad member', member);
        const res = await fetch(`${memberUrl}/${member.id}`, { method: 'DELETE' });
        if (res.status !== 204) {
          // If you see errors here, it's likely that the cluster has lost a quorum,
          // and can no longer function. If you can recover some of the down instances,
          // that would be good. If not, you'll have to recover the cluster.
          // See https://github.com/coreos/etcd/blob/master/Documentation/admin_guide.md#disaster-recovery
          // And some discussion at https://github.com/coreos/etcd/issues/3505
          fail(`Error deleting bad member ${res.status} ${await res.text()}`);
        }
      }

      // Add the new member to the cluster
      console.error('Adding self to existing cluster');
      const add = await fetch(memberUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerURLs: [myPeerUrl] }),
      });

      if (add.status !== 201) {
        fail(`Error joining cluster: ${add.status} ${JSON.stringify(await add.text())}`);
      }

      console.error(`  got id ${(await add.json()).id}`);

      // remove bad members from the members list, and add ourselves.
      goodMembers.push({ name: instanceId, peerURLs: [myPeerUrl] });
      members = goodMembers;
    }

    console.error('Members', JSON.stringify(members, null, 2));

    const invalidMembers = _.filter(members, m => (!m.name || _.isEmpty(m.peerURLs)));
    if (!_.isEmpty(invalidMembers)) {
      fail(`Cannot join cluster with invalid members ${JSON.stringify(invalidMembers, null, 2)}`);
    }

    const cluster = _.map(members, m => `${m.name}=${m.peerURLs[0]}`).join(',');
    console.log('ETCD_INITIAL_CLUSTER_STATE=existing');
    console.log(`ETCD_INITIAL_CLUSTER=${cluster}`);
  }
};

go().catch(err => fail(err.stack));
