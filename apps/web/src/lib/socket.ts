// Socket.io client singleton
import { io, Socket } from "socket.io-client";
import { SERVER_URL } from "@/lib/api";
import { getAccessKey } from "@/lib/access-key";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SERVER_URL, {
      transports: ["websocket"],
      autoConnect: false,
      // Re-read the key each (re)connect attempt so saving it in the unlock
      // screen takes effect without a page reload.
      auth: (cb) => cb({ key: getAccessKey() }),
    });
  }
  return socket;
}

export function connectSocket(): void {
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }
}

export function disconnectSocket(): void {
  if (socket?.connected) {
    socket.disconnect();
  }
}
