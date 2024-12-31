slopify-chat-server
===================

Simple websocket server to relay and limit chat messages for Slopify.

## Implementation Details
The client connects over WebSocket, and sends messages as JSON, formatted as
`{ "type": "<type>" }`, with any payload fields being additional fields in the same object.

### Initial Connection
1) The client connects over WebSocket.
2) The client sends a "nick" type message, with the "nick" field being their desired nick.
3) The server tells the client if their nick was accepted or not. If accepted, the server broadcasts the nick change to everyone.
4) The client sends a "room" type message, with the "room" field being the room they want to join.
5) The server tells the client if their join request was accepted or not. If accepted, the server broadcasts the join to everyone.

The client can repeat 2) and 4) as much as they want to change their nick or the room they want to join.

### Chatting
The client can send a message with type "chat" and the payload field "body" to chat in the room they are currently in. The server will return
an error if their message can't be sent due to being invalid.

The server will send a message with type "chat" and the payload fields "nick" and "body" to all members in a room, whenever someone chats.

### Reserved Nicks
There exists the concept of "reserved nicks". These are nicks (usernames) that nobody can use unless they have the secret key.

Reserved nicks are stored in `reserved_nicks.json`, as a mapping of the secret key to the name it will unlock. To use a reserved nick, set your name on the client
to be the secret key, and the server will set your nick to the actual nick.

## Usage
First time, or after an update: `pnpm install`.
Run the server: `pnpm start`.
