const db = require('../config/database');

class CallHandler {
  constructor(io) {
    this.io = io;
    this.activeCalls = new Map(); // oderId -> { oderId, status, startTime }
    this.userSockets = new Map(); // userId -> Set of socket ids
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
    for (const [callerId, call] of this.activeCalls) {
      if (callerId === userId || call.targetUserId === userId) {
        return true;
      }
    }
    return false;
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

  // Manejar solicitud de llamada
  async handleCallRequest(socket, data) {
    const callerId = socket.userId;
    const { targetUserId, offer } = data;

    console.log(`📞 Llamada: Usuario ${callerId} -> Usuario ${targetUserId}`);

    // Verificar si el llamante ya está en una llamada
    if (this.isUserInCall(callerId)) {
      socket.emit('call_error', { message: 'Ya estás en una llamada' });
      return;
    }

    // Verificar si el destinatario está en una llamada
    if (this.isUserInCall(targetUserId)) {
      socket.emit('call_busy', { userId: targetUserId });
      return;
    }

    // Obtener sockets del destinatario
    const targetSockets = this.getUserSockets(targetUserId);

    if (targetSockets.length === 0) {
      socket.emit('call_error', { message: 'Usuario no disponible' });
      return;
    }

    // Obtener nombre del llamante
    const callerName = await this.getUserName(callerId);

    // Registrar llamada activa
    this.activeCalls.set(callerId, {
      targetUserId,
      status: 'ringing',
      startTime: Date.now(),
      offer
    });

    // Enviar notificación de llamada entrante al destinatario
    targetSockets.forEach(targetSocket => {
      targetSocket.emit('call_incoming', {
        callerId,
        callerName,
        offer
      });
    });

    console.log(`📞 Llamada enviada a ${targetSockets.length} socket(s) del usuario ${targetUserId}`);
  }

  // Manejar aceptación de llamada
  async handleCallAccept(socket, data) {
    const receiverId = socket.userId;
    const { callerId } = data;

    console.log(`✅ Llamada aceptada: Usuario ${receiverId} aceptó llamada de ${callerId}`);

    const call = this.activeCalls.get(callerId);
    if (!call) {
      socket.emit('call_error', { message: 'Llamada no encontrada' });
      return;
    }

    // Actualizar estado de la llamada
    call.status = 'connecting';
    this.activeCalls.set(callerId, call);

    // Enviar la offer al que aceptó la llamada
    socket.emit('call_offer', {
      callerId,
      offer: call.offer
    });
  }

  // Manejar envío de respuesta SDP
  handleCallAnswerSend(socket, data) {
    const { targetUserId, answer } = data;

    console.log(`📤 Enviando answer a usuario ${targetUserId}`);

    const targetSockets = this.getUserSockets(targetUserId);
    targetSockets.forEach(targetSocket => {
      targetSocket.emit('call_answer', { answer });
    });

    // Actualizar estado de la llamada
    const call = this.activeCalls.get(targetUserId);
    if (call) {
      call.status = 'connected';
      this.activeCalls.set(targetUserId, call);
    }
  }

  // Manejar rechazo de llamada
  handleCallReject(socket, data) {
    const receiverId = socket.userId;
    const { callerId } = data;

    console.log(`❌ Llamada rechazada: Usuario ${receiverId} rechazó llamada de ${callerId}`);

    // Eliminar llamada activa
    this.activeCalls.delete(callerId);

    // Notificar al llamante
    const callerSockets = this.getUserSockets(callerId);
    callerSockets.forEach(callerSocket => {
      callerSocket.emit('call_rejected', { userId: receiverId });
    });
  }

  // Manejar fin de llamada
  handleCallEnd(socket, data) {
    const userId = socket.userId;
    const { oderId, reason } = data;

    console.log(`📴 Llamada terminada por usuario ${userId}, razón: ${reason}`);

    // Buscar y eliminar la llamada activa
    let callToEnd = null;
    let callKey = null;

    // Buscar si el usuario es el que inició la llamada
    if (this.activeCalls.has(userId)) {
      callToEnd = this.activeCalls.get(userId);
      callKey = userId;
    } else {
      // Buscar si el usuario es el destinatario
      for (const [callerId, call] of this.activeCalls) {
        if (call.targetUserId === userId) {
          callToEnd = call;
          callKey = callerId;
          break;
        }
      }
    }

    if (callToEnd) {
      this.activeCalls.delete(callKey);

      // Notificar al otro usuario
      const otherUserId = callKey === userId ? callToEnd.targetUserId : callKey;
      const otherSockets = this.getUserSockets(otherUserId);
      otherSockets.forEach(otherSocket => {
        otherSocket.emit('call_ended', { reason: reason || 'ended' });
      });
    }
  }

  // Manejar ICE candidate
  handleIceCandidate(socket, data) {
    const { targetUserId, candidate } = data;

    const targetSockets = this.getUserSockets(targetUserId);
    targetSockets.forEach(targetSocket => {
      targetSocket.emit('call_ice_candidate', { candidate });
    });
  }

  // Manejar desconexión de usuario
  handleDisconnection(socket) {
    const userId = socket.userId;

    // Verificar si el usuario tenía una llamada activa
    let callToEnd = null;
    let callKey = null;

    if (this.activeCalls.has(userId)) {
      callToEnd = this.activeCalls.get(userId);
      callKey = userId;
    } else {
      for (const [callerId, call] of this.activeCalls) {
        if (call.targetUserId === userId) {
          callToEnd = call;
          callKey = callerId;
          break;
        }
      }
    }

    if (callToEnd) {
      this.activeCalls.delete(callKey);

      // Notificar al otro usuario
      const otherUserId = callKey === userId ? callToEnd.targetUserId : callKey;
      const otherSockets = this.getUserSockets(otherUserId);
      otherSockets.forEach(otherSocket => {
        otherSocket.emit('call_ended', { reason: 'disconnected' });
      });

      console.log(`📴 Llamada terminada por desconexión del usuario ${userId}`);
    }
  }
}

module.exports = CallHandler;
