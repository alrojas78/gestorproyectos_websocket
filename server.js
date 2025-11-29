require('dotenv').config();

const { createServer } = require('http');
const { Server } = require('socket.io');
const { socketAuthMiddleware } = require('./middleware/auth');
const ChatHandler = require('./handlers/chatHandler');
const CallHandler = require('./handlers/callHandler');

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
    origin: [
      process.env.FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:5173',
      'https://d.ateneo.co'
    ],
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Middleware de autenticación
io.use(socketAuthMiddleware);

// Inicializar handlers
const chatHandler = new ChatHandler(io);
const callHandler = new CallHandler(io);

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

  // ===== EVENTOS DE CONEXIÓN =====

  // Evento: Desconexión
  socket.on('disconnect', async (reason) => {
    console.log(`Desconexión: Usuario ${socket.userId}, razón: ${reason}`);
    await chatHandler.handleDisconnection(socket);
    callHandler.handleDisconnection(socket);
  });

  // Manejar errores
  socket.on('error', (error) => {
    console.error(`Error en socket ${socket.id}:`, error);
  });
});

// Iniciar servidor
httpServer.listen(PORT, () => {
  console.log(`🚀 WebSocket Server corriendo en puerto ${PORT}`);
  console.log(`📡 Frontend URL: ${process.env.FRONTEND_URL}`);
});

// Manejar errores no capturados
process.on('uncaughtException', (error) => {
  console.error('Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada no manejada:', reason);
});
