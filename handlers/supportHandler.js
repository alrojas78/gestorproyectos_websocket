const db = require('../config/database');

class SupportHandler {
  constructor(io) {
    this.io = io;
    // Referencia al namespace del widget
    this.widgetNamespace = io.of('/support-widget');
    // Mapa de sesiones de widget: sessionToken -> Set of socket ids
    this.widgetSessions = new Map();
    // Mapa de agentes: agentId -> Set of socket ids
    this.agentSockets = new Map();
    // Mapa de agentes por canal: channelId -> Set of agentIds
    this.channelAgents = new Map();
  }

  // =====================================================
  // CONEXIONES DE AGENTES (usuarios internos del sistema)
  // =====================================================

  // Registrar agente conectado
  async handleAgentConnection(socket) {
    const userId = socket.userId;

    // Agregar socket del agente
    if (!this.agentSockets.has(userId)) {
      this.agentSockets.set(userId, new Set());
    }
    this.agentSockets.get(userId).add(socket.id);

    // Obtener canales asignados al agente
    const channels = await this.getAgentChannels(userId);

    // Unir a salas de sus canales
    for (const channel of channels) {
      socket.join(`support_channel_${channel.id}`);

      // Registrar en mapa de canal
      if (!this.channelAgents.has(channel.id)) {
        this.channelAgents.set(channel.id, new Set());
      }
      this.channelAgents.get(channel.id).add(userId);
    }

    console.log(`[SUPPORT] Agente ${userId} conectado a ${channels.length} canales`);
  }

  // Desconexión de agente
  async handleAgentDisconnection(socket) {
    const userId = socket.userId;

    if (this.agentSockets.has(userId)) {
      this.agentSockets.get(userId).delete(socket.id);

      if (this.agentSockets.get(userId).size === 0) {
        this.agentSockets.delete(userId);

        // Remover de canales
        for (const [channelId, agents] of this.channelAgents) {
          agents.delete(userId);
        }
      }
    }

    console.log(`[SUPPORT] Agente ${userId} desconectado`);
  }

  // Agente se une a una sesión específica
  async handleAgentJoinSession(socket, data) {
    const { sessionId } = data;

    if (!sessionId) {
      socket.emit('support_error', { message: 'sessionId requerido' });
      return;
    }

    socket.join(`support_session_${sessionId}`);
    console.log(`[SUPPORT] Agente ${socket.userId} unido a sesión ${sessionId}`);

    // Resetear contador de no leídos cuando el agente abre la sesión
    await this.resetUnreadCount(sessionId);

    // Notificar al cliente
    this.io.to(`support_session_${sessionId}`).emit('agent_joined', {
      sessionId,
      agentId: socket.userId,
      timestamp: new Date()
    });

    // Notificar que los mensajes fueron leídos (para actualizar badges en otros clientes del agente)
    this.io.to(`support_channel_${socket.supportChannelId}`).emit('support_session_read', {
      sessionId,
      agentId: socket.userId,
      timestamp: new Date()
    });
  }

  // Agente envía mensaje
  async handleAgentMessage(socket, data) {
    try {
      const { sessionId, content, messageType = 'text' } = data;
      const agentId = socket.userId;

      if (!sessionId || !content) {
        socket.emit('support_error', { message: 'sessionId y content requeridos' });
        return;
      }

      // Verificar acceso
      const hasAccess = await this.checkAgentSessionAccess(agentId, sessionId);
      if (!hasAccess) {
        socket.emit('support_error', { message: 'No tienes acceso a esta sesión' });
        return;
      }

      // Guardar mensaje
      const message = await this.saveSupportMessage(sessionId, {
        sender_type: 'agent',
        sender_id: agentId,
        content: this.sanitizeContent(content),
        message_type: messageType
      });

      // Obtener info del agente
      const agent = await this.getAgentInfo(agentId);
      message.sender_name = agent ? agent.name : 'Agente';
      message.sender_avatar = agent ? agent.avatar_url : null;

      // Actualizar última actividad de sesión
      await this.updateSessionActivity(sessionId);

      // Emitir a todos en la sesión (namespace principal para agentes)
      this.io.to(`support_session_${sessionId}`).emit('support_message', {
        sessionId,
        message
      });

      // Emitir también al namespace del widget
      this.widgetNamespace.to(`support_session_${sessionId}`).emit('support_message', {
        sessionId,
        message
      });

      console.log(`[SUPPORT] Mensaje de agente ${agentId} en sesión ${sessionId}`);

    } catch (error) {
      console.error('[SUPPORT] Error enviando mensaje de agente:', error);
      socket.emit('support_error', { message: 'Error al enviar mensaje' });
    }
  }

  // Agente escribe
  handleAgentTyping(socket, data) {
    const { sessionId, isTyping } = data;

    const typingData = {
      sessionId,
      userId: socket.userId,
      userType: 'agent',
      isTyping,
      timestamp: new Date()
    };

    // Emitir a ambos namespaces
    this.io.to(`support_session_${sessionId}`).emit('support_typing', typingData);
    this.widgetNamespace.to(`support_session_${sessionId}`).emit('support_typing', typingData);
  }

  // =====================================================
  // CONEXIONES DE WIDGET (clientes externos)
  // =====================================================

  // Widget se conecta
  async handleWidgetConnection(socket, data) {
    const { sessionToken, embedCode } = data;

    if (!sessionToken || !embedCode) {
      socket.emit('support_error', { message: 'sessionToken y embedCode requeridos' });
      return;
    }

    // Verificar sesión
    const session = await this.getSupportSession(sessionToken);
    if (!session) {
      socket.emit('support_error', { message: 'Sesión inválida' });
      return;
    }

    // Registrar socket del widget
    if (!this.widgetSessions.has(sessionToken)) {
      this.widgetSessions.set(sessionToken, new Set());
    }
    this.widgetSessions.get(sessionToken).add(socket.id);

    // Unir a sala de la sesión
    socket.join(`support_session_${session.id}`);

    // Guardar datos en el socket
    socket.supportSessionId = session.id;
    socket.supportSessionToken = sessionToken;
    socket.supportChannelId = session.channel_id;

    console.log(`[SUPPORT] Widget conectado a sesión ${session.id}`);

    // Notificar a agentes del canal
    this.io.to(`support_channel_${session.channel_id}`).emit('new_support_session', {
      session,
      timestamp: new Date()
    });

    // Enviar confirmación al widget
    socket.emit('widget_connected', {
      sessionId: session.id,
      channelId: session.channel_id
    });
  }

  // Widget se desconecta
  handleWidgetDisconnection(socket) {
    const sessionToken = socket.supportSessionToken;

    if (sessionToken && this.widgetSessions.has(sessionToken)) {
      this.widgetSessions.get(sessionToken).delete(socket.id);

      if (this.widgetSessions.get(sessionToken).size === 0) {
        this.widgetSessions.delete(sessionToken);

        // Notificar a agentes que el cliente se desconectó
        if (socket.supportSessionId) {
          this.io.to(`support_session_${socket.supportSessionId}`).emit('customer_disconnected', {
            sessionId: socket.supportSessionId,
            timestamp: new Date()
          });
        }
      }
    }

    console.log(`[SUPPORT] Widget desconectado de sesión ${socket.supportSessionId}`);
  }

  // Widget envía mensaje
  async handleWidgetMessage(socket, data) {
    try {
      const sessionId = socket.supportSessionId;
      const { content, messageType = 'text' } = data;

      if (!sessionId || !content) {
        socket.emit('support_error', { message: 'content requerido' });
        return;
      }

      // Obtener info de la sesión para el nombre del cliente
      const session = await this.getSessionById(sessionId);

      // Guardar mensaje
      const message = await this.saveSupportMessage(sessionId, {
        sender_type: 'customer',
        content: this.sanitizeContent(content),
        message_type: messageType
      });

      message.sender_name = session ? session.external_name : 'Cliente';

      // Actualizar última actividad
      await this.updateSessionActivity(sessionId);
      await this.incrementMessageCount(sessionId);
      // Incrementar contador de no leídos para agentes
      await this.incrementUnreadCount(sessionId);

      const messageData = {
        sessionId,
        message
      };

      // Emitir a todos en la sesión (namespace principal para agentes que están viendo esa sesión)
      this.io.to(`support_session_${sessionId}`).emit('support_message', messageData);

      // Emitir también al namespace del widget (para otros widgets con la misma sesión)
      this.widgetNamespace.to(`support_session_${sessionId}`).emit('support_message', messageData);

      // IMPORTANTE: Emitir también al canal para que TODOS los agentes del canal reciban la notificación
      // aunque no estén viendo esa sesión específica
      if (socket.supportChannelId) {
        this.io.to(`support_channel_${socket.supportChannelId}`).emit('support_message', messageData);

        this.io.to(`support_channel_${socket.supportChannelId}`).emit('session_updated', {
          sessionId,
          lastMessage: content,
          timestamp: new Date()
        });
      }

      console.log(`[SUPPORT] Mensaje de cliente en sesión ${sessionId}, canal ${socket.supportChannelId}`);

    } catch (error) {
      console.error('[SUPPORT] Error enviando mensaje de widget:', error);
      socket.emit('support_error', { message: 'Error al enviar mensaje' });
    }
  }

  // Widget escribe
  handleWidgetTyping(socket, data) {
    const sessionId = socket.supportSessionId;
    const { isTyping } = data;

    if (sessionId) {
      this.io.to(`support_session_${sessionId}`).emit('support_typing', {
        sessionId,
        userType: 'customer',
        isTyping,
        timestamp: new Date()
      });
    }
  }

  // =====================================================
  // EVENTOS DEL SISTEMA
  // =====================================================

  // Notificar respuesta de IA
  broadcastAIResponse(sessionId, message) {
    this.io.to(`support_session_${sessionId}`).emit('support_message', {
      sessionId,
      message: {
        ...message,
        sender_type: 'ai',
        sender_name: 'Asistente IA'
      }
    });
  }

  // Notificar asignación de agente
  broadcastAgentAssigned(sessionId, agentId, agentName) {
    this.io.to(`support_session_${sessionId}`).emit('agent_assigned', {
      sessionId,
      agentId,
      agentName,
      timestamp: new Date()
    });
  }

  // Notificar cierre de sesión
  broadcastSessionClosed(sessionId) {
    this.io.to(`support_session_${sessionId}`).emit('session_closed', {
      sessionId,
      timestamp: new Date()
    });
  }

  // Notificar escalación
  broadcastSessionEscalated(sessionId, ticketNumber) {
    this.io.to(`support_session_${sessionId}`).emit('session_escalated', {
      sessionId,
      ticketNumber,
      timestamp: new Date()
    });
  }

  // =====================================================
  // HELPERS - BASE DE DATOS
  // =====================================================

  async getAgentChannels(userId) {
    const [rows] = await db.query(
      `SELECT sc.id, sc.project_id, sc.embed_code, p.name as project_name
       FROM support_channels sc
       JOIN support_channel_agents sca ON sca.channel_id = sc.id
       JOIN projects p ON p.id = sc.project_id
       WHERE sca.user_id = ? AND sca.is_active = 1 AND sc.enabled = 1`,
      [userId]
    );
    return rows;
  }

  async getSupportSession(sessionToken) {
    const [rows] = await db.query(
      `SELECT ss.*, sc.embed_code, sc.brand_name
       FROM support_sessions ss
       JOIN support_channels sc ON sc.id = ss.channel_id
       WHERE ss.session_token = ?`,
      [sessionToken]
    );
    return rows[0] || null;
  }

  async getSessionById(sessionId) {
    const [rows] = await db.query(
      `SELECT * FROM support_sessions WHERE id = ?`,
      [sessionId]
    );
    return rows[0] || null;
  }

  async checkAgentSessionAccess(agentId, sessionId) {
    const [rows] = await db.query(
      `SELECT 1 FROM support_sessions ss
       JOIN support_channel_agents sca ON sca.channel_id = ss.channel_id
       WHERE ss.id = ? AND sca.user_id = ? AND sca.is_active = 1`,
      [sessionId, agentId]
    );
    return rows.length > 0;
  }

  async saveSupportMessage(sessionId, messageData) {
    const [result] = await db.query(
      `INSERT INTO support_messages (session_id, sender_type, sender_id, content, message_type, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        messageData.sender_type,
        messageData.sender_id || null,
        messageData.content,
        messageData.message_type || 'text',
        messageData.metadata ? JSON.stringify(messageData.metadata) : null
      ]
    );

    return {
      id: result.insertId,
      session_id: sessionId,
      sender_type: messageData.sender_type,
      sender_id: messageData.sender_id,
      content: messageData.content,
      message_type: messageData.message_type || 'text',
      created_at: new Date()
    };
  }

  async getAgentInfo(agentId) {
    const [rows] = await db.query(
      `SELECT id, name, email, avatar_url FROM users WHERE id = ?`,
      [agentId]
    );
    return rows[0] || null;
  }

  async updateSessionActivity(sessionId) {
    await db.query(
      `UPDATE support_sessions SET last_activity = NOW() WHERE id = ?`,
      [sessionId]
    );
  }

  async incrementMessageCount(sessionId) {
    await db.query(
      `UPDATE support_sessions SET messages_count = messages_count + 1 WHERE id = ?`,
      [sessionId]
    );
  }

  async incrementUnreadCount(sessionId) {
    await db.query(
      `UPDATE support_sessions SET unread_count = unread_count + 1 WHERE id = ?`,
      [sessionId]
    );
  }

  async resetUnreadCount(sessionId) {
    await db.query(
      `UPDATE support_sessions SET unread_count = 0 WHERE id = ?`,
      [sessionId]
    );
  }

  // Sanitizar contenido
  sanitizeContent(content) {
    if (!content) return '';
    return content
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .substring(0, 5000);
  }
}

module.exports = SupportHandler;
