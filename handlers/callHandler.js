const db = require('../config/database');

class CallHandler {
  constructor(io) {
    this.io = io;
    this.activeCalls = new Map(); // callId -> { callId, hostId, participants, status, startTime }
    this.userCalls = new Map(); // oderId -> callId (para saber en qué llamada está cada usuario)
  }

  // Generar ID único para la llamada
  generateCallId() {
    return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Obtener sockets de un usuario
  getUserSockets(userId) {
    const sockets = [];
    for (const [socketId, socket] of this.io.sockets.sockets) {
      if (socket.userId === userId) {
        sockets.push(socket);
      }
    }
    return sockets;
  }

  // Verificar si un usuario está en llamada
  isUserInCall(userId) {
    return this.userCalls.has(userId);
  }

  // Obtener la llamada de un usuario
  getUserCall(userId) {
    const callId = this.userCalls.get(userId);
    return callId ? this.activeCalls.get(callId) : null;
  }

  // Obtener nombre del usuario
  async getUserName(userId) {
    try {
      const [rows] = await db.execute(
        'SELECT name FROM users WHERE id = ?',
        [userId]
      );
      return rows.length > 0 ? rows[0].name : 'Usuario';
    } catch (error) {
      console.error('Error getting user name:', error);
      return 'Usuario';
    }
  }

  // Obtener info de múltiples usuarios
  async getUsersInfo(userIds) {
    try {
      if (userIds.length === 0) return [];
      const placeholders = userIds.map(() => '?').join(',');
      const [rows] = await db.execute(
        `SELECT id, name FROM users WHERE id IN (${placeholders})`,
        userIds
      );
      return rows;
    } catch (error) {
      console.error('Error getting users info:', error);
      return [];
    }
  }

  // Manejar solicitud de llamada (puede ser a uno o varios usuarios)
  async handleCallRequest(socket, data) {
    const callerId = socket.userId;
    const { targetUserIds, offer, callType } = data;

    // Compatibilidad con llamadas individuales (targetUserId)
    const targets = Array.isArray(targetUserIds)
      ? targetUserIds
      : [data.targetUserId];

    const callTypeLabel = callType === 'video' ? 'Videollamada' : 'Llamada';
    console.log(`📞 ${callTypeLabel}: Usuario ${callerId} -> Usuarios ${targets.join(', ')}`);

    // Verificar si el llamante ya está en una llamada
    if (this.isUserInCall(callerId)) {
      socket.emit('call_error', { message: 'Ya estás en una llamada' });
      return;
    }

    // Verificar disponibilidad de cada destinatario
    const unavailable = [];
    const available = [];

    for (const targetId of targets) {
      if (this.isUserInCall(targetId)) {
        unavailable.push(targetId);
      } else {
        const targetSockets = this.getUserSockets(targetId);
        if (targetSockets.length > 0) {
          available.push({ userId: targetId, sockets: targetSockets });
        } else {
          unavailable.push(targetId);
        }
      }
    }

    if (available.length === 0) {
      socket.emit('call_error', { message: 'Ningún usuario está disponible' });
      return;
    }

    // Crear llamada grupal
    const callId = this.generateCallId();
    const callerName = await this.getUserName(callerId);

    const call = {
      callId,
      hostId: callerId,
      hostName: callerName,
      participants: new Map([[callerId, { oderId: callerId, status: 'connected', joinedAt: Date.now() }]]),
      pendingInvites: new Set(available.map(a => a.userId)),
      status: 'ringing',
      startTime: Date.now(),
      offer,
      callType: callType || 'audio' // 'audio' o 'video'
    };

    this.activeCalls.set(callId, call);
    this.userCalls.set(callerId, callId);

    // Unir al host a la room de la llamada
    socket.join(`call_${callId}`);

    // Notificar al host con el callId generado
    socket.emit('call_created', {
      callId,
      status: 'ringing',
      invitedCount: available.length,
      callType: call.callType
    });

    // Enviar notificación de llamada entrante a cada destinatario disponible
    for (const { userId, sockets } of available) {
      sockets.forEach(targetSocket => {
        targetSocket.emit('call_incoming', {
          callId,
          callerId,
          callerName,
          isGroupCall: targets.length > 1,
          participantCount: targets.length + 1,
          offer,
          callType: call.callType
        });
      });
    }

    // Notificar usuarios no disponibles
    if (unavailable.length > 0) {
      socket.emit('call_users_unavailable', { userIds: unavailable });
    }

    console.log(`📞 Llamada ${callId} creada. Invitados: ${available.length}, No disponibles: ${unavailable.length}`);
  }

  // Manejar aceptación de llamada
  async handleCallAccept(socket, data) {
    const oderId = socket.userId;
    const { callerId, callId } = data;

    // Buscar la llamada por callId o por callerId (compatibilidad)
    let call = callId ? this.activeCalls.get(callId) : null;

    if (!call) {
      // Buscar por callerId para compatibilidad con versión anterior
      for (const [id, c] of this.activeCalls) {
        if (c.hostId === callerId && c.pendingInvites.has(oderId)) {
          call = c;
          break;
        }
      }
    }

    if (!call) {
      socket.emit('call_error', { message: 'Llamada no encontrada' });
      return;
    }

    console.log(`✅ Llamada aceptada: Usuario ${oderId} se une a llamada ${call.callId}`);

    // Registrar al usuario como participante
    call.pendingInvites.delete(oderId);
    call.participants.set(oderId, { oderId, status: 'connecting', joinedAt: Date.now() });
    this.userCalls.set(oderId, call.callId);
    call.status = 'active';

    // Unir a la room de la llamada
    socket.join(`call_${call.callId}`);

    // Obtener nombre del usuario que se une
    const userName = await this.getUserName(oderId);

    // Notificar a todos los participantes que alguien se unió
    this.io.to(`call_${call.callId}`).emit('call_participant_joined', {
      callId: call.callId,
      oderId,
      userId: oderId,
      userName,
      participantCount: call.participants.size
    });

    // Enviar la offer al que aceptó la llamada
    socket.emit('call_offer', {
      callId: call.callId,
      callerId: call.hostId,
      offer: call.offer,
      participants: Array.from(call.participants.keys())
    });
  }

  // Manejar envío de respuesta SDP
  handleCallAnswerSend(socket, data) {
    const { targetUserId, answer, callId } = data;

    console.log(`📤 Enviando answer a usuario ${targetUserId}`);

    // Obtener el callId de la llamada activa si no viene en data
    const userId = socket.userId;
    const activeCallId = callId || this.userCalls.get(userId);

    const targetSockets = this.getUserSockets(targetUserId);
    targetSockets.forEach(targetSocket => {
      targetSocket.emit('call_answer', {
        answer,
        fromUserId: socket.userId,
        callId: activeCallId
      });
    });

    // Actualizar estado del participante
    const call = callId ? this.activeCalls.get(callId) : this.getUserCall(socket.userId);
    if (call && call.participants.has(socket.userId)) {
      call.participants.get(socket.userId).status = 'connected';
    }
  }

  // Manejar envío de offer a un peer específico (para mesh network)
  handleCallOfferSend(socket, data) {
    const { targetUserId, offer, callId } = data;

    console.log(`📤 Enviando offer a usuario ${targetUserId} para llamada ${callId}`);

    const targetSockets = this.getUserSockets(targetUserId);
    targetSockets.forEach(targetSocket => {
      targetSocket.emit('call_offer', {
        offer,
        callerId: socket.userId,
        callId: callId
      });
    });
  }

  // Agregar participante a llamada en curso
  async handleAddParticipant(socket, data) {
    const { callId, targetUserId } = data;
    const oderId = socket.userId;

    const call = this.activeCalls.get(callId);
    if (!call) {
      socket.emit('call_error', { message: 'Llamada no encontrada' });
      return;
    }

    // Verificar que el usuario es participante de la llamada
    if (!call.participants.has(oderId)) {
      socket.emit('call_error', { message: 'No eres participante de esta llamada' });
      return;
    }

    // Verificar que el nuevo usuario no está ya en la llamada
    if (call.participants.has(targetUserId) || call.pendingInvites.has(targetUserId)) {
      socket.emit('call_error', { message: 'El usuario ya está en la llamada o fue invitado' });
      return;
    }

    // Verificar disponibilidad del usuario
    if (this.isUserInCall(targetUserId)) {
      socket.emit('call_error', { message: 'El usuario está en otra llamada' });
      return;
    }

    const targetSockets = this.getUserSockets(targetUserId);
    if (targetSockets.length === 0) {
      socket.emit('call_error', { message: 'El usuario no está disponible' });
      return;
    }

    // Agregar a pendientes
    call.pendingInvites.add(targetUserId);

    // Obtener nombres
    const inviterName = await this.getUserName(oderId);
    const participantNames = await this.getUsersInfo(Array.from(call.participants.keys()));

    // Notificar al usuario invitado
    targetSockets.forEach(targetSocket => {
      targetSocket.emit('call_incoming', {
        callId,
        callerId: call.hostId,
        callerName: call.hostName,
        invitedBy: inviterName,
        isGroupCall: true,
        participantCount: call.participants.size + 1,
        participants: participantNames,
        offer: call.offer,
        callType: call.callType || 'audio'
      });
    });

    // Notificar a los participantes actuales
    this.io.to(`call_${callId}`).emit('call_participant_invited', {
      callId,
      targetUserId,
      invitedBy: oderId,
      invitedByName: inviterName
    });

    console.log(`📞 Usuario ${targetUserId} invitado a llamada ${callId} por ${oderId}`);
  }

  // Manejar rechazo de llamada
  handleCallReject(socket, data) {
    const oderId = socket.userId;
    const { callerId, callId } = data;

    // Buscar la llamada
    let call = callId ? this.activeCalls.get(callId) : null;

    if (!call) {
      for (const [id, c] of this.activeCalls) {
        if (c.hostId === callerId && c.pendingInvites.has(oderId)) {
          call = c;
          break;
        }
      }
    }

    if (!call) return;

    console.log(`❌ Llamada rechazada: Usuario ${oderId} rechazó llamada ${call.callId}`);

    // Remover de pendientes
    call.pendingInvites.delete(oderId);

    // Notificar a participantes
    this.io.to(`call_${call.callId}`).emit('call_participant_rejected', {
      callId: call.callId,
      oderId
    });

    // Si no quedan participantes ni pendientes además del host, terminar llamada
    if (call.participants.size === 1 && call.pendingInvites.size === 0) {
      this.endCall(call.callId, 'rejected');
    }
  }

  // Manejar fin de llamada (usuario sale)
  handleCallEnd(socket, data) {
    const userId = socket.userId;
    const { reason } = data;

    const callId = this.userCalls.get(userId);
    if (!callId) return;

    const call = this.activeCalls.get(callId);
    if (!call) return;

    console.log(`📴 Usuario ${userId} salió de llamada ${callId}, razón: ${reason}`);

    // Remover al usuario de participantes
    call.participants.delete(userId);
    this.userCalls.delete(userId);
    socket.leave(`call_${callId}`);

    // Notificar a otros participantes
    const userName = socket.userName || 'Usuario';
    this.io.to(`call_${callId}`).emit('call_participant_left', {
      callId,
      oderId: userId,
      userName,
      participantCount: call.participants.size,
      reason
    });

    // Si era el host o no quedan participantes suficientes, terminar llamada
    if (userId === call.hostId || call.participants.size < 1) {
      this.endCall(callId, userId === call.hostId ? 'host_left' : 'ended');
    }
  }

  // Terminar llamada completamente
  endCall(callId, reason) {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    console.log(`📴 Terminando llamada ${callId}, razón: ${reason}`);

    // Notificar a todos
    this.io.to(`call_${callId}`).emit('call_ended', { callId, reason });

    // Limpiar participantes
    for (const [oderId] of call.participants) {
      this.userCalls.delete(oderId);
      const sockets = this.getUserSockets(oderId);
      sockets.forEach(s => s.leave(`call_${callId}`));
    }

    // Limpiar pendientes
    for (const oderId of call.pendingInvites) {
      // Por si acaso estaban en proceso
    }

    this.activeCalls.delete(callId);
  }

  // Manejar ICE candidate
  handleIceCandidate(socket, data) {
    const { targetUserId, candidate, callId } = data;

    const targetSockets = this.getUserSockets(targetUserId);
    targetSockets.forEach(targetSocket => {
      targetSocket.emit('call_ice_candidate', {
        candidate,
        fromUserId: socket.userId,
        callId
      });
    });
  }

  // Obtener info de la llamada actual
  handleGetCallInfo(socket) {
    const oderId = socket.userId;
    const call = this.getUserCall(oderId);

    if (!call) {
      socket.emit('call_info', { inCall: false });
      return;
    }

    const participants = [];
    for (const [id, data] of call.participants) {
      participants.push({ userId: id, ...data });
    }

    socket.emit('call_info', {
      inCall: true,
      callId: call.callId,
      isHost: call.hostId === oderId,
      hostId: call.hostId,
      hostName: call.hostName,
      participants,
      pendingInvites: Array.from(call.pendingInvites),
      startTime: call.startTime
    });
  }

  // Manejar mensaje de chat en llamada
  handleCallChatMessage(socket, data) {
    const userId = socket.userId;
    const { callId, content, senderName } = data;

    // Verificar que el usuario está en una llamada
    const userCallId = this.userCalls.get(userId);
    if (!userCallId || userCallId !== callId) {
      socket.emit('call_error', { message: 'No estás en esta llamada' });
      return;
    }

    const call = this.activeCalls.get(callId);
    if (!call) {
      return;
    }

    // Broadcast del mensaje a todos los participantes de la llamada (excepto al emisor)
    socket.to(`call_${callId}`).emit('call_chat_message', {
      callId,
      senderId: userId,
      senderName: senderName || 'Usuario',
      content,
      timestamp: Date.now()
    });

    console.log(`💬 Chat en llamada ${callId}: ${senderName || 'Usuario'}: ${content.substring(0, 50)}...`);
  }

  // Manejar desconexión de usuario
  handleDisconnection(socket) {
    const userId = socket.userId;

    // Verificar si el usuario tenía una llamada activa
    const callId = this.userCalls.get(userId);
    if (!callId) return;

    const call = this.activeCalls.get(callId);
    if (!call) return;

    // Verificar si el usuario tiene otros sockets conectados
    const remainingSockets = this.getUserSockets(userId).filter(s => s.id !== socket.id);

    if (remainingSockets.length > 0) {
      // Tiene otros sockets, mantener en llamada
      return;
    }

    console.log(`📴 Usuario ${userId} desconectado de llamada ${callId}`);

    // Remover de participantes
    call.participants.delete(userId);
    this.userCalls.delete(userId);

    // Notificar a otros
    this.io.to(`call_${callId}`).emit('call_participant_left', {
      callId,
      oderId: userId,
      participantCount: call.participants.size,
      reason: 'disconnected'
    });

    // Si era el host o no quedan suficientes participantes, terminar
    if (userId === call.hostId || call.participants.size < 1) {
      this.endCall(callId, 'disconnected');
    }
  }
}

module.exports = CallHandler;
