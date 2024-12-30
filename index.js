import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { Address6 } from 'ip-address';
import { RateLimiter } from './rate_limit.js';

/* The HTTP server and crap */
const server = createServer();
const wss = new WebSocketServer({ server });

/* State variables */
const connectedUsers = new Set();
const rateLimiter = new RateLimiter(10, 60 * 1000, 5);

function getMaskedRemoteAddress(addr) {
  // v6 address, stick a /64 mask on
  if (addr.indexOf(':') !== -1) {
    const v6 = new Address6(addr);

    return v6.mask(64);
  }

  return addr;
}

function broadcast(message) {
  wss.clients.forEach(client => client.send(JSON.stringify(message)));
}

wss.on('connection', (conn, req) => {
  let addr;
  if ('cf-connecting-ip' in req.headers) {
    addr = getMaskedRemoteAddress(req.headers['cf-connecting-ip']);
  } else {
    addr = getMaskedRemoteAddress(req.socket.remoteAddress);
  }

  console.log('Accepting connection from', addr);

  let username = null;

  conn.on('message', (msg) => {
    msg = JSON.parse(msg.toString());
    console.log('Message', msg);
    // They want to change their nick.
    if (msg.type === 'nick') {
      let { nick } = msg;

      nick = nick.trim();

      if (nick.length < 1 || nick.length > 16) {
        conn.send(JSON.stringify(
          { type: 'error', error: 'nick_bounds' }
        ));
        return;
      }

      if (connectedUsers.has(nick)) {
        conn.send(JSON.stringify(
          { type: 'error', error: 'nick_taken' }
        ));
        return;
      }

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
    // Sending a chat message.
    else if (msg.type === 'chat') {
      let { body } = msg;

      if (!username) {
        conn.send(JSON.stringify(
          { type: 'error', error: 'not_registered' }
        ));
        return;
      }

      if (!body) {
        conn.send(JSON.stringify(
          { type: 'error', error: 'no_message' }
        ));
        return;
      }

      body = body.trim();

      if (body.length < 1 || body.length > 1024) {
        conn.send(JSON.stringify(
          { type: 'error', error: 'message_bounds' }
        ));
        return;
      }

      // Returns true if request is allowed
      if (rateLimiter.hit(addr)) {
        broadcast({ type: 'chat', nick: username, body });
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
      console.log(`${username} disconnected.`);
    }
  })
});

server.listen(8080);