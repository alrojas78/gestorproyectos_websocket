require('dotenv').config();

const { createServer } = require('http');
const { Server } = require('socket.io');
const { socketAuthMiddleware } = require('./middleware/auth');
const ChatHandler = require('./handlers/chatHandler');
const CallHandler = require('./handlers/callHandler');
const SupportHandler = require('./handlers/supportHandler');

const PORT = process.env.PORT || 3001;

// Crear servidor HTTP
const httpServer = createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

// Configurar Socket.io
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      // Permitir conexiones sin origin (apps móviles, Postman, etc.)
      if (!origin) return callback(null, true);

      // Dominios siempre permitidos
      const allowedDomains = [
        process.env.FRONTEND_URL,
        'http://localhost:3000',
        'http://localhost:5173',
        'https://d.ateneo.co'
      ];

      if (allowedDomains.includes(origin)) {
        return callback(null, true);
      }

      // Para el widget de soporte, permitir cualquier origen
      // La validación se hace con el embed_code en el handler
      return callback(null, true);
    },
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Middleware de autenticación para namespace principal
io.use(socketAuthMiddleware);

// Inicializar handlers
const chatHandler = new ChatHandler(io);
const callHandler = new CallHandler(io);
const supportHandler = new SupportHandler(io);

// ===== NAMESPACE DE WIDGET (sin autenticación) =====
const widgetNamespace = io.of('/support-widget');

widgetNamespace.on('connection', (socket) => {
  console.log(`[WIDGET] Nueva conexión de widget: ${socket.id}`);

  // Widget se conecta a una sesión
  socket.on('widget_connect', (data) => {
    supportHandler.handleWidgetConnection(socket, data);
  });

  // Widget envía mensaje
  socket.on('widget_message', (data) => {
    supportHandler.handleWidgetMessage(socket, data);
  });

  // Widget indica que está escribiendo
  socket.on('widget_typing', (data) => {
    supportHandler.handleWidgetTyping(socket, data);
  });

  // Widget se desconecta
  socket.on('disconnect', () => {
    supportHandler.handleWidgetDisconnection(socket);
    console.log(`[WIDGET] Widget desconectado: ${socket.id}`);
  });
});

// Manejar conexiones
io.on('connection', async (socket) => {
  console.log(`Nueva conexión: Usuario ${socket.userId}`);

  // Registrar conexión
  await chatHandler.handleConnection(socket);

  // ===== EVENTOS DE CHAT =====

  // Evento: Enviar mensaje
  socket.on('send_message', (data) => {
    chatHandler.handleSendMessage(socket, data);
  });

  // Evento: Escribiendo
  socket.on('typing', (data) => {
    chatHandler.handleTyping(socket, data);
  });

  // Evento: Marcar como leído
  socket.on('mark_read', (data) => {
    chatHandler.handleMarkRead(socket, data);
  });

  // Evento: Unirse a conversación
  socket.on('join_conversation', (data) => {
    chatHandler.handleJoinConversation(socket, data);
  });

  // Evento: Mensaje eliminado (notificar a otros)
  socket.on('message_deleted', (data) => {
    const { conversationId, messageId } = data;
    socket.to(`conversation_${conversationId}`).emit('message_deleted', {
      conversationId,
      messageId,
      deletedBy: socket.userId
    });
  });

  // ===== EVENTOS DE SOPORTE (para agentes) =====

  // Evento: Agente se conecta al sistema de soporte
  socket.on('support_agent_connect', () => {
    supportHandler.handleAgentConnection(socket);
  });

  // Evento: Agente se une a una sesión de soporte
  socket.on('support_agent_join', (data) => {
    supportHandler.handleAgentJoinSession(socket, data);
  });

  // Evento: Agente envía mensaje de soporte
  socket.on('support_agent_message', (data) => {
    supportHandler.handleAgentMessage(socket, data);
  });

  // Evento: Agente escribiendo
  socket.on('support_agent_typing', (data) => {
    supportHandler.handleAgentTyping(socket, data);
  });

  // Evento: Agente cierra sesion (emite evento de encuesta al widget)
  socket.on('support_agent_close_session', (data) => {
    supportHandler.handleAgentCloseSession(socket, data);
  });

  // ===== EVENTOS DE LLAMADAS =====

  // Evento: Solicitar llamada
  socket.on('call_request', (data) => {
    callHandler.handleCallRequest(socket, data);
  });

  // Evento: Aceptar llamada
  socket.on('call_accept', (data) => {
    callHandler.handleCallAccept(socket, data);
  });

  // Evento: Rechazar llamada
  socket.on('call_reject', (data) => {
    callHandler.handleCallReject(socket, data);
  });

  // Evento: Terminar llamada
  socket.on('call_end', (data) => {
    callHandler.handleCallEnd(socket, data);
  });

  // Evento: Enviar respuesta SDP
  socket.on('call_answer_send', (data) => {
    callHandler.handleCallAnswerSend(socket, data);
  });

  // Evento: Enviar offer a peer específico (para conexiones mesh en llamadas grupales)
  socket.on('call_offer_send', (data) => {
    callHandler.handleCallOfferSend(socket, data);
  });

  // Evento: Enviar ICE candidate
  socket.on('call_ice_candidate', (data) => {
    callHandler.handleIceCandidate(socket, data);
  });

  // Evento: Agregar participante a llamada
  socket.on('call_add_participant', (data) => {
    callHandler.handleAddParticipant(socket, data);
  });

  // Evento: Obtener info de llamada actual
  socket.on('call_get_info', () => {
    callHandler.handleGetCallInfo(socket);
  });

  // Evento: Mensaje de chat en llamada
  socket.on('call_chat_message', (data) => {
    callHandler.handleCallChatMessage(socket, data);
  });

  // ===== EVENTOS DE CONEXIÓN =====

  // Evento: Desconexión
  socket.on('disconnect', async (reason) => {
    console.log(`Desconexión: Usuario ${socket.userId}, razón: ${reason}`);
    await chatHandler.handleDisconnection(socket);
    callHandler.handleDisconnection(socket);
    supportHandler.handleAgentDisconnection(socket);
  });

  // Manejar errores
  socket.on('error', (error) => {
    console.error(`Error en socket ${socket.id}:`, error);
  });
});

// Exportar supportHandler para uso en API (notificaciones de IA)
module.exports = { io, supportHandler };

// Iniciar servidor
httpServer.listen(PORT, () => {
  console.log(`WebSocket Server corriendo en puerto ${PORT}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL}`);
  console.log(`Support Widget namespace: /support-widget`);
});

// Manejar errores no capturados
process.on('uncaughtException', (error) => {
  console.error('Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada no manejada:', reason);
});
