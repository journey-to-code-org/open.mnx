// Presence device to device: once two viewers of a room have found each other through the
// server, they open a WebRTC data channel and send presence over it directly. On one network the
// traffic stays there; in any case the server stops carrying every pointer move. It still carries
// what a channel can't: introductions (a newcomer's first presence), goodbyes, the signaling to
// open a channel, and presence to anyone without one. Documents never go this way; their changes
// go through the log, which is what makes them durable.
//
// Turned on by connect({ webrtc: true }) or connect({ webrtc: { iceServers } }). Peers on one
// network need no ICE servers; across networks, give STUN, and TURN for pairs that can't connect
// directly (the app provides it; see docs/sync.md).

/**
 * `signal(room, to, data)` sends signaling through the server. Returns the transport's half:
 * `{ receiveSignal, sawPeer, lostPeer, send(message) → true if every peer in the room got it
 * directly, close }`. `deliver(message)` gets presence that arrives over a channel.
 */
export function mesh({ self, signal, deliver, iceServers = [] }) {
  const peers = new Map(); // peer → { connection, channel, rooms: Set }
  const rooms = new Map(); // room → Set of peers seen in it

  const open = (peer) => peers.get(peer)?.channel?.readyState === 'open';

  function link(peer, room) {
    let entry = peers.get(peer);
    if (entry) {
      entry.rooms.add(room);
      return entry;
    }
    const connection = new RTCPeerConnection({ iceServers });
    entry = { connection, channel: null, rooms: new Set([room]), pending: [] };
    peers.set(peer, entry);
    connection.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) signal(room, peer, { candidate: candidate.toJSON() });
    });
    connection.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed'].includes(connection.connectionState)) drop(peer);
    });
    const attach = (channel) => {
      entry.channel = channel;
      channel.addEventListener('message', ({ data }) => {
        try {
          const message = JSON.parse(data);
          // Only presence, only from the peer on this channel.
          if (message && message.peer === peer && typeof message.room === 'string') deliver(message);
        } catch {}
      });
      channel.addEventListener('close', () => drop(peer));
    };
    connection.addEventListener('datachannel', ({ channel }) => attach(channel));
    // One side starts: the lower id. Both know both ids, so they agree without talking.
    if (self < peer) {
      attach(connection.createDataChannel('presence', { ordered: false, maxRetransmits: 0 }));
      connection
        .createOffer()
        .then((offer) => connection.setLocalDescription(offer))
        .then(() => signal(room, peer, { description: connection.localDescription.toJSON() }))
        .catch(() => drop(peer));
    }
    return entry;
  }

  function drop(peer) {
    const entry = peers.get(peer);
    if (!entry) return;
    peers.delete(peer);
    try { entry.connection.close(); } catch {}
  }

  async function receiveSignal({ room, from, data }) {
    if (from === self) return;
    const entry = link(from, room);
    const { connection } = entry;
    try {
      if (data.description) {
        await connection.setRemoteDescription(data.description);
        for (const candidate of entry.pending.splice(0)) await connection.addIceCandidate(candidate);
        if (data.description.type === 'offer') {
          await connection.setLocalDescription(await connection.createAnswer());
          signal(room, from, { description: connection.localDescription.toJSON() });
        }
      } else if (data.candidate) {
        // Candidates can arrive before the description they belong to.
        if (connection.remoteDescription) await connection.addIceCandidate(data.candidate);
        else entry.pending.push(data.candidate);
      }
    } catch {
      drop(from);
    }
  }

  return {
    receiveSignal,
    /** A peer's presence arrived through the server: meet it, if we're both here. */
    sawPeer(room, peer, state) {
      if (peer === self) return;
      if (!rooms.has(room)) rooms.set(room, new Set());
      if (state === null) {
        rooms.get(room).delete(peer);
        const entry = peers.get(peer);
        entry?.rooms.delete(room);
        if (entry && entry.rooms.size === 0) drop(peer);
        return;
      }
      rooms.get(room).add(peer);
      link(peer, room);
    },
    /** Send presence over the open channels; true if that reached everyone known in the room. */
    send(message) {
      const known = rooms.get(message.room);
      let everyone = Boolean(known && known.size);
      for (const peer of known ?? []) {
        if (open(peer)) {
          try {
            peers.get(peer).channel.send(JSON.stringify(message));
          } catch {
            everyone = false;
          }
        } else {
          everyone = false;
        }
      }
      return everyone;
    },
    /** The peers there's an open channel to. */
    direct: () => [...peers.keys()].filter(open),
    close() {
      for (const peer of [...peers.keys()]) drop(peer);
    },
  };
}
