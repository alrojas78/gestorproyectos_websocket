const jwt = require('jsonwebtoken');

// Función para decodificar JWT usando el mismo algoritmo que PHP
function verifyToken(token) {
  try {
    // El JWT de PHP usa HS256
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded;
  } catch (error) {
    console.error('Error verificando token:', error.message);
    return null;
  }
}

// Middleware para Socket.io
function socketAuthMiddleware(socket, next) {
  const token = socket.handshake.auth.token || socket.handshake.query.token;

  if (!token) {
    return next(new Error('Token no proporcionado'));
  }

  const decoded = verifyToken(token);

  if (!decoded) {
    return next(new Error('Token inválido'));
  }

  // Agregar datos del usuario al socket
  socket.userId = decoded.id;
  socket.userName = decoded.name || 'Usuario';

  next();
}

module.exports = { verifyToken, socketAuthMiddleware };
