import ip from 'ip';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { RateLimiter } from './rate_limit.js';


interface ConnectionState {
  addr: string,
  conn: WebSocket,
  username?: string,
  room?: string
}

/* The HTTP server and crap */
const server = createServer();
const wss = new WebSocketServer({ server });

/* State variables */
const connectedUsers = new Set();
const roomUsers : Record<string, Set<string>> = {}; // Usernames in each room
const roomCons : Record<string, WebSocket[]> = {}; // WS connections in each room
const rateLimiter = new RateLimiter(10, 60 * 1000, 5);

const reservedNicks = new Map<string, string>();
const inverseReservedNicks = new Set<string>();

/**
 * If the remote address is an IPv6 address, return the /64 it's a part of; otherwise return the whole address.
 * This is used for rate-limiting, because in the IPv6 world, each host gets a whole /64 and as such the entire /64
 * should be treated as one address for rate-limiting or blocking purposes.
 */
function getMaskedRemoteAddress(addr: string | string[] | undefined) {
  if (!addr) {
    throw new Error('Got a connection without a remote address, this should never happen.');
  }

  if (Array.isArray(addr)) {
    addr = addr[0];
  }

  // v6 address, stick a /64 mask on
  if (ip.isV6Format(addr)) {
    if (ip.isPrivate(addr)) {
      return addr;
    }

    // /64, this library is a little silly so I have to spell it out.
    return ip.mask(addr, 'FFFF:FFFF:FFFF:FFFF:0000:0000:0000:0000');
  }

  return addr;
}

function broadcast(message: unknown) {
  wss.clients.forEach(client => client.send(JSON.stringify(message)));
}

function broadcastToRoom(room: string, message: unknown) {
  for (const conn of roomCons[room]) {
    conn.send(JSON.stringify(message));
  }
}

function arrayDel(ary: unknown[], itm: unknown) {
  const idx = ary.indexOf(itm);

  if (idx !== -1) {
    ary.splice(idx, 1);
  }
}

/** Called when we receive a message of type: nick from the client */
function handleNick(state: ConnectionState, { nick }: { nick: string }) {
  const { conn } = state;
  const sentNick = nick;

  nick = nick.trim();

  // Don't let people use a reserved nick without the secret key.
  if (inverseReservedNicks.has(nick)) {
    conn.send(JSON.stringify(
      { type: 'error', error: 'nick_reserved' }
    ));
    return;
  }

  // Replace the secret key with the actual nick.
  if (reservedNicks.has(nick)) {
    nick = reservedNicks.get(nick)!;
  }

  // Nick is too short or too long.
  if (nick.length < 1 || nick.length > 16) {
    conn.send(JSON.stringify(
      { type: 'error', error: 'nick_bounds' }
    ));
    return;
  }

  // Nick already taken
  if (connectedUsers.has(nick)) {
    conn.send(JSON.stringify(
      { type: 'error', error: 'nick_taken' }
    ));
    return;
  }

  // If they're changing their name from an existing one, get rid of the old connected user.
  if (state.username) {
    connectedUsers.delete(state.username);
  }

  connectedUsers.add(nick);

  console.log(`User ${state.username} changed name to ${nick}`);
  broadcast({ type: 'nick', prev_nick: state.username, nick: nick });

  state.username = nick;
  
  // Confirm their nick choice.
  conn.send(JSON.stringify(
    { type: 'nick', nick: sentNick }
  ));
}

function handleRoom(state: ConnectionState, { room }: { room: string }) {
  const { conn, username } = state;

  if (!username) {
    conn.send(JSON.stringify(
      { type: 'error', error: 'not_registered' }
    ));
    return;
  }

  if (!room) {
    conn.send(JSON.stringify(
      { type: 'error', error: 'room_bounds' }
    ));
    return;
  }

  room = room.trim();

  if (room.length < 0 || room.length > 16) {
    conn.send(JSON.stringify(
      { type: 'error', error: 'room_bounds' }
    ));
    return;
  }

  // Leave the current room
  if (state.room) {
    roomUsers[state.room].delete(username);
    arrayDel(roomCons[state.room], conn);
  }

  console.log(`${username} switched from room ${state.room} to ${room}.`);

  state.room = room;

  // Join the room :-)
  if (!(room in roomUsers)) {
    roomUsers[room] = new Set();
    roomCons[room] = [];
  }

  roomUsers[room].add(username);
  roomCons[room].push(conn);
}

function handleChat(state: ConnectionState, { body }: { body: string }) {
  const { addr, conn, room, username } = state;
   // Not yet registered
   if (!username) {
    conn.send(JSON.stringify(
      { type: 'error', error: 'not_registered' }
    ));
    return;
  }

  if (!room) {
    conn.send(JSON.stringify(
      { type: 'error', error: 'not_in_room' }
    ));
    return;
  }

  // Empty message
  if (!body) {
    conn.send(JSON.stringify(
      { type: 'error', error: 'no_message' }
    ));
    return;
  }

  body = body.trim();

  // Message too long?
  if (body.length < 1 || body.length > 1024) {
    conn.send(JSON.stringify(
      { type: 'error', error: 'message_bounds' }
    ));
    return;
  }

  broadcastToRoom(room, { type: 'chat', nick: username, body });
}

function loadReservedNicks() {
  const data = JSON.parse(
    readFileSync('reserved_nicks.json').toString()
  );

  for (const key in data) {
    reservedNicks.set(key, data[key]);
    inverseReservedNicks.add(data[key]);
  }
}

wss.on('connection', (conn, req) => {
  let addr;

  // Are we behind Cloudflare?
  if ('cf-connecting-ip' in req.headers) {
    addr = getMaskedRemoteAddress(req.headers['cf-connecting-ip']);
  } else {
    addr = getMaskedRemoteAddress(req.socket.remoteAddress);
  }

  let state : ConnectionState = { addr, conn };

  console.log('Accepting connection from', addr);

  conn.on('message', (buffer) => {
    // Rate limiting - returns true if request is allowed
    if (!rateLimiter.hit(addr)) {
      conn.send(JSON.stringify(
        { type: 'error', error: 'rate_limited' }
      ));
      return;
    }

    const msg = JSON.parse(buffer.toString());

    console.log(addr, 'Message', msg);

    // They want to change their nick.
    if (msg.type === 'nick') {
      if (typeof(msg.nick) === 'string') {
        handleNick(state, msg);
      }
    }
    // Joining a room
    else if (msg.type === 'room') {
      if (typeof(msg.room) === 'string') {
        handleRoom(state, msg);
      }
    }
    // Sending a chat message.
    else if (msg.type === 'chat') {
      if (typeof(msg.body) === 'string') {
        handleChat(state, msg);
      }
    }
  });

  conn.on('close', () => {
    const { username, room } = state;

    if (username) {
      connectedUsers.delete(username);

      if (room) {
        roomUsers[room].delete(username);
        arrayDel(roomCons[room], conn);
      }

      console.log(`${username} disconnected.`);
    }
  })
});

const PORT = 8080;

loadReservedNicks();

server.listen(PORT);
console.log(`Chat server listening on ${PORT}.`);
