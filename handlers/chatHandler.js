const db = require('../config/database');

class ChatHandler {
  constructor(io) {
    this.io = io;
    this.userSockets = new Map(); // userId -> Set of socket ids
  }

  // Registrar usuario conectado
  async handleConnection(socket) {
    const userId = socket.userId;

    // Agregar socket a la lista de este usuario
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId).add(socket.id);

    // Actualizar estado online en DB
    await this.setUserOnline(userId, socket.id);

    // Notificar a todos que el usuario está online
    this.io.emit('user_online', { userId, timestamp: new Date() });

    // Unir al usuario a sus conversaciones
    await this.joinUserConversations(socket, userId);

    console.log(`Usuario ${userId} conectado (socket: ${socket.id})`);
  }

  // Manejar desconexión
  async handleDisconnection(socket) {
    const userId = socket.userId;

    // Remover socket de la lista
    if (this.userSockets.has(userId)) {
      this.userSockets.get(userId).delete(socket.id);

      // Si no quedan más sockets, marcar como offline
      if (this.userSockets.get(userId).size === 0) {
        this.userSockets.delete(userId);
        await this.setUserOffline(userId);
        this.io.emit('user_offline', { userId, timestamp: new Date() });
      }
    }

    console.log(`Usuario ${userId} desconectado (socket: ${socket.id})`);
  }

  // Enviar mensaje
  async handleSendMessage(socket, data) {
    try {
      console.log(`[SEND_MESSAGE] Recibido de usuario ${socket.userId}:`, JSON.stringify(data));

      const { conversationId, content, messageType = 'text' } = data;
      const senderId = socket.userId;

      if (!conversationId) {
        console.error(`[SEND_MESSAGE] ERROR: conversationId es undefined. Data recibida:`, data);
        socket.emit('error', { message: 'conversationId es requerido' });
        return;
      }

      // Validar que el usuario es participante
      const isParticipant = await this.checkParticipant(conversationId, senderId);
      console.log(`[SEND_MESSAGE] Usuario ${senderId} es participante de conv ${conversationId}: ${isParticipant}`);

      if (!isParticipant) {
        socket.emit('error', { message: 'No tienes acceso a esta conversación' });
        return;
      }

      // Sanitizar contenido
      const sanitizedContent = this.sanitizeContent(content);

      // Guardar mensaje en DB
      const message = await this.saveMessage(conversationId, senderId, sanitizedContent, messageType);
      console.log(`[SEND_MESSAGE] Mensaje guardado con ID: ${message.id}`);

      // Ver cuántos sockets están en la sala
      const room = this.io.sockets.adapter.rooms.get(`conversation_${conversationId}`);
      const socketsInRoom = room ? room.size : 0;
      console.log(`[SEND_MESSAGE] Emitiendo a conversation_${conversationId} (${socketsInRoom} sockets en sala)`);

      // Emitir mensaje a todos los participantes de la conversación
      this.io.to(`conversation_${conversationId}`).emit('new_message', {
        ...message,
        conversationId
      });

      console.log(`[SEND_MESSAGE] Mensaje emitido exitosamente`);

    } catch (error) {
      console.error('[SEND_MESSAGE] Error:', error);
      socket.emit('error', { message: 'Error al enviar mensaje' });
    }
  }

  // Indicador de escritura
  handleTyping(socket, data) {
    const { conversationId, isTyping } = data;
    socket.to(`conversation_${conversationId}`).emit('typing', {
      userId: socket.userId,
      userName: socket.userName,
      conversationId,
      isTyping
    });
  }

  // Marcar mensajes como leídos
  async handleMarkRead(socket, data) {
    try {
      const { conversationId } = data;
      const userId = socket.userId;

      await this.markConversationRead(conversationId, userId);

      // Notificar a otros participantes
      socket.to(`conversation_${conversationId}`).emit('messages_read', {
        conversationId,
        userId,
        timestamp: new Date()
      });

    } catch (error) {
      console.error('Error marcando como leído:', error);
    }
  }

  // Unirse a una conversación específica
  async handleJoinConversation(socket, data) {
    console.log(`[JOIN_CONVERSATION] Recibido de usuario ${socket.userId}:`, JSON.stringify(data));

    const { conversationId } = data;
    const userId = socket.userId;

    if (!conversationId) {
      console.error(`[JOIN_CONVERSATION] ERROR: conversationId undefined. Data:`, data);
      return;
    }

    const isParticipant = await this.checkParticipant(conversationId, userId);
    console.log(`[JOIN_CONVERSATION] Usuario ${userId} es participante: ${isParticipant}`);

    if (isParticipant) {
      socket.join(`conversation_${conversationId}`);
      socket.emit('joined_conversation', { conversationId });

      // Verificar cuántos sockets hay en la sala ahora
      const room = this.io.sockets.adapter.rooms.get(`conversation_${conversationId}`);
      console.log(`[JOIN_CONVERSATION] Usuario ${userId} unido a conversation_${conversationId}. Total en sala: ${room ? room.size : 0}`);
    }
  }

  // ----- Funciones auxiliares de base de datos -----

  async setUserOnline(userId, socketId) {
    try {
      await db.execute(
        `INSERT INTO user_online_status (user_id, is_online, last_seen, socket_id)
         VALUES (?, 1, NOW(), ?)
         ON DUPLICATE KEY UPDATE is_online = 1, last_seen = NOW(), socket_id = ?`,
        [userId, socketId, socketId]
      );
    } catch (error) {
      console.error('Error setting user online:', error);
    }
  }

  async setUserOffline(userId) {
    try {
      await db.execute(
        `UPDATE user_online_status SET is_online = 0, last_seen = NOW(), socket_id = NULL WHERE user_id = ?`,
        [userId]
      );
    } catch (error) {
      console.error('Error setting user offline:', error);
    }
  }

  async checkParticipant(conversationId, userId) {
    try {
      const [rows] = await db.execute(
        'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
        [conversationId, userId]
      );
      return rows.length > 0;
    } catch (error) {
      console.error('Error checking participant:', error);
      return false;
    }
  }

  async saveMessage(conversationId, senderId, content, messageType) {
    try {
      const [result] = await db.execute(
        `INSERT INTO messages (conversation_id, sender_id, content, message_type)
         VALUES (?, ?, ?, ?)`,
        [conversationId, senderId, content, messageType]
      );

      // Actualizar timestamp de conversación
      await db.execute(
        'UPDATE conversations SET updated_at = NOW() WHERE id = ?',
        [conversationId]
      );

      // Obtener el mensaje completo con datos del remitente
      const [messages] = await db.execute(
        `SELECT m.*, u.name as sender_name
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.id = ?`,
        [result.insertId]
      );

      return messages[0];
    } catch (error) {
      console.error('Error saving message:', error);
      throw error;
    }
  }

  async markConversationRead(conversationId, userId) {
    try {
      await db.execute(
        'UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?',
        [conversationId, userId]
      );
    } catch (error) {
      console.error('Error marking as read:', error);
    }
  }

  async joinUserConversations(socket, userId) {
    try {
      const [conversations] = await db.execute(
        'SELECT conversation_id FROM conversation_participants WHERE user_id = ?',
        [userId]
      );

      for (const conv of conversations) {
        socket.join(`conversation_${conv.conversation_id}`);
      }
    } catch (error) {
      console.error('Error joining conversations:', error);
    }
  }

  sanitizeContent(content) {
    if (!content) return '';
    // Escapar HTML para prevenir XSS
    return content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
      .trim()
      .substring(0, 5000); // Limitar longitud
  }

  // Obtener sockets de un usuario
  getUserSockets(userId) {
    return this.userSockets.get(userId) || new Set();
  }

  // Verificar si usuario está online
  isUserOnline(userId) {
    return this.userSockets.has(userId) && this.userSockets.get(userId).size > 0;
  }
}

module.exports = ChatHandler;
