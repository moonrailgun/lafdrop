import cloud from '@lafjs/cloud';
const parser = require('ua-parser-js');
const {
  uniqueNamesGenerator,
  animals,
  colors,
} = require('unique-names-generator');

type WsMap = Map<
  WebSocket,
  {
    id: string;
    peer: Peer;
  }
>;

function getWsMap(): WsMap {
  let wsMap = cloud.shared.get('wsMap') as WsMap;
  if (!wsMap) {
    wsMap = new Map();
    cloud.shared.set('wsMap', wsMap);
  }

  return wsMap;
}

export async function main(ctx: FunctionContext) {
  const wsMap = getWsMap();
  const server = new Server(ctx);

  // websocket 连接成功
  if (ctx.method === 'WebSocket:connection') {
    const socketId = generateSocketId();
    const peer = new Peer(ctx, socketId);
    wsMap.set(ctx.socket, {
      id: socketId,
      peer,
    });
    // 加入房间
    server.joinRoom(peer);
    console.log(`新用户加入, 当前在线: ${wsMap.size} 人`);
    // ctx.socket.send("连接成功,你的 socketId 是："+ socketId);
  }

  // websocket 消息事件
  if (ctx.method === 'WebSocket:message') {
    const { data } = ctx.params;
    const raw = String(data);
    const target = wsMap.get(ctx.socket);
    if (!target) {
      return;
    }

    server.onMessage(target.peer, raw);
  }

  // websocket 关闭消息
  if (ctx.method === 'WebSocket:close') {
    const target = wsMap.get(ctx.socket);
    if (!target) {
      return;
    }

    server.leaveRoom(target.peer);
    wsMap.delete(ctx.socket);
    console.log(`老用户离开, 当前在线: ${wsMap.size} 人`);
  }
}

// 生成随机socket ID
function generateSocketId() {
  return Math.random().toString(36).substring(2, 15);
}

class Server {
  constructor(public ctx: FunctionContext) {}

  getRooms(): Promise<Record<string, Record<string, Peer>>> {
    let rooms = cloud.shared.get('rooms');
    if (!rooms) {
      rooms = {};
      cloud.shared.set('rooms', rooms);
    }

    return rooms;
  }

  joinRoom(peer: Peer) {
    const rooms = this.getRooms();

    if (!rooms[peer.ip]) {
      rooms[peer.ip] = {};
    }

    for (const otherPeerId in rooms[peer.ip]) {
      const otherPeer = rooms[peer.ip][otherPeerId];
      this._send(otherPeer, {
        type: 'peer-joined',
        peer: peer.getInfo(),
      });
    }

    const otherPeers = [];
    for (const otherPeerId in rooms[peer.ip]) {
      otherPeers.push(rooms[peer.ip][otherPeerId].getInfo());
    }

    this._send(peer, {
      type: 'peers',
      peers: otherPeers,
    });

    rooms[peer.ip][peer.id] = peer;

    this._send(peer, {
      type: 'display-name',
      message: {
        displayName: peer.name.displayName,
        deviceName: peer.name.deviceName,
      },
    });
  }

  onMessage(sender: Peer, message: string) {
    // Try to parse message
    let json: any;
    try {
      json = JSON.parse(message);
    } catch (e) {
      return; // TODO: handle malformed JSON
    }

    switch (json.type) {
      case 'disconnect':
        this.leaveRoom(sender);
        break;
      case 'pong':
        sender.lastBeat = Date.now();
        break;
    }

    // relay message to recipient
    const rooms = this.getRooms();
    if (json.to && rooms[sender.ip]) {
      const recipientId = json.to; // TODO: sanitize
      const recipient = rooms[sender.ip][recipientId];
      delete json.to;
      // add sender id
      json.sender = sender.id;
      this._send(recipient, json);
      return;
    }
  }

  leaveRoom(peer: Peer) {
    const rooms = this.getRooms();

    if (!rooms[peer.ip] || !rooms[peer.ip][peer.id]) {
      return;
    }

    // delete the peer
    delete rooms[peer.ip][peer.id];

    peer.socket.close();
    //if room is empty, delete the room
    if (!Object.keys(rooms[peer.ip]).length) {
      delete rooms[peer.ip];
    } else {
      // notify all other peers
      for (const otherPeerId in rooms[peer.ip]) {
        const otherPeer = rooms[peer.ip][otherPeerId];
        this._send(otherPeer, { type: 'peer-left', peerId: peer.id });
      }
    }
  }

  private _send(peer: Peer, message: any) {
    if (!peer) return;

    message = JSON.stringify(message);
    peer.socket.send(message);
  }
}

class Peer {
  socket: WebSocket;
  ip: string;
  rtcSupported: boolean;
  name: any;
  timerId: number;
  lastBeat: number;

  constructor(ctx: FunctionContext, public id: string) {
    // set socket
    this.socket = ctx.socket;

    // set remote ip
    this.ip = ctx.headers['x-real-ip'];

    // is WebRTC supported ?
    // this.rtcSupported = ctx. request.url.indexOf('webrtc') > -1;
    this.rtcSupported = true;
    // set name
    this._setName(ctx);
    // for keepalive
    this.timerId = 0;
    this.lastBeat = Date.now();
  }

  _setName(req) {
    let ua = parser(req.headers['user-agent']);

    let deviceName = '';

    if (ua.os && ua.os.name) {
      deviceName = ua.os.name.replace('Mac OS', 'Mac') + ' ';
    }

    if (ua.device.model) {
      deviceName += ua.device.model;
    } else {
      deviceName += ua.browser.name;
    }

    if (!deviceName) deviceName = 'Unknown Device';

    const displayName = uniqueNamesGenerator({
      length: 2,
      separator: ' ',
      dictionaries: [colors, animals],
      style: 'capital',
      seed: hashCode(this.id),
    });

    this.name = {
      model: ua.device.model,
      os: ua.os.name,
      browser: ua.browser.name,
      type: ua.device.type,
      deviceName,
      displayName,
    };
  }

  getInfo() {
    return {
      id: this.id,
      name: this.name,
      rtcSupported: this.rtcSupported,
    };
  }
}

function hashCode(str: string) {
  let hash = 0,
    i: number,
    chr: number;
  for (i = 0; i < str.length; i++) {
    chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}
