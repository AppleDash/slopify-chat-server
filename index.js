import ip from 'ip';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { RateLimiter } from './rate_limit.js';

/* The HTTP server and crap */
const server = createServer();
const wss = new WebSocketServer({ server });

/* State variables */
const connectedUsers = new Set();
const roomUsers = {}; // Usernames in each room
const roomCons = {}; // WS connections in each room
const rateLimiter = new RateLimiter(10, 60 * 1000, 5);

function getMaskedRemoteAddress(addr) {
  console.log('Addr', addr);
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

function broadcast(message) {
  wss.clients.forEach(client => client.send(JSON.stringify(message)));
}

function broadcastToRoom(room, message) {
  for (const conn of roomCons[room]) {
    conn.send(JSON.stringify(message));
  }
}

function arrayDel(ary, itm) {
  const idx = ary.indexOf(itm);

  if (idx !== -1) {
    ary.splice(idx, 1);
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

  console.log('Accepting connection from', addr);

  let username = null;
  let currentRoom = null;

  conn.on('message', (msg) => {
    msg = JSON.parse(msg.toString());
    console.log('Message', msg);
    // They want to change their nick.
    if (msg.type === 'nick') {
      let { nick } = msg;

      nick = nick.trim();

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

      // If they're changing their name from an existing one, get rid of the connected users.
      if (username) {
        connectedUsers.delete(username);
      }

      connectedUsers.add(nick);

      console.log(`User ${username} changed name to ${nick}`);
      broadcast({ type: 'nick', prev_nick: username, nick: nick });
      username = nick;
      conn.send(JSON.stringify(
        { type: 'nick', nick: username }
      ));

    }
    // Joining a room
    else if (msg.type === 'room') {
      let { room } = msg;

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
      if (currentRoom) {
        roomUsers[currentRoom].delete(username);
        arrayDel(roomCons[currentRoom], conn);
      }

      console.log(`${username} switched from room ${currentRoom} to ${room}.`);

      currentRoom = room;

      // Join the room :-)
      if (!(room in roomUsers)) {
        roomUsers[room] = new Set();
        roomCons[room] = [];
      }

      roomUsers[room].add(username);
      roomCons[room].push(conn);
    }
    // Sending a chat message.
    else if (msg.type === 'chat') {
      let { body } = msg;

      // Not yet registered
      if (!username) {
        conn.send(JSON.stringify(
          { type: 'error', error: 'not_registered' }
        ));
        return;
      }

      if (!currentRoom) {
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

      // Rate limiting - returns true if request is allowed
      if (rateLimiter.hit(addr)) {
        broadcastToRoom(currentRoom, { type: 'chat', nick: username, body });
        // broadcast({ type: 'chat', nick: username, body });
      } else {
        conn.send(JSON.stringify(
          { type: 'error', error: 'rate_limited' }
        ));
      }
    }
  });

  conn.on('close', () => {
    if (username !== null) {
      connectedUsers.delete(username);

      if (currentRoom) {
        roomUsers[currentRoom].delete(username);
        arrayDel(roomCons[currentRoom], conn);
      }

      console.log(`${username} disconnected.`);
    }
  })
});

const PORT = 8080;

server.listen(PORT);
console.log(`Chat server listening on ${PORT}.`);
