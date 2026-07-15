/**
 * DTOs and interfaces for chat events.
 */

export interface StoredMessage {
  id: string;
  userId: string;
  username: string;
  avatar: string;
  message: string;
  roomId: string | null;
  targetUserId?: string | null;
  timestamp: number;
}


export interface ChatMessagePayload {
  userId: string;
  username: string;
  avatar?: string;
  message: string;
  roomId?: string;
  timestamp?: string;
}

export interface TypingPayload {
  userId: string;
  username: string;
  roomId?: string;
  isTyping: boolean;
}

export interface JoinRoomPayload {
  userId: string;
  username: string;
  roomId: string;
}

export interface ConnectedUser {
  socketId: string;
  userId: string;
  username: string;
  avatar: string;
  joinedRooms: Set<string>;
}

export interface RoomHistoryResponse {
  roomId: string;
  messages: StoredMessage[];
}

/** Room entity (persisted). */
export interface Room {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
}

/** Room list item sent to clients. */
export interface RoomListItem {
  id: string;
  name: string;
  createdBy: string;
  isPrivate: boolean;
}
