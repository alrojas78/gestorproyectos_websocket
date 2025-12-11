const db = require('../config/database');
const https = require('https');

class PushService {
  constructor() {
    this.EXPO_PUSH_URL = 'exp.host';
    this.EXPO_PUSH_PATH = '/--/api/v2/push/send';
  }

  // Enviar notificacion push a traves de Expo
  async sendPush(tokens, title, body, data = {}, channelId = 'default') {
    if (!tokens || tokens.length === 0) {
      return { success: false, error: 'No tokens provided' };
    }

    // Asegurar que tokens sea un array
    if (!Array.isArray(tokens)) {
      tokens = [tokens];
    }

    // Filtrar y preparar mensajes
    const messages = [];
    for (const tokenInfo of tokens) {
      const token = typeof tokenInfo === 'object' ? tokenInfo.token : tokenInfo;

      // Validar token de Expo
      if (!token || !token.match(/^ExponentPushToken\[.+\]$/)) {
        console.log('[PUSH] Token invalido ignorado:', token);
        continue;
      }

      messages.push({
        to: token,
        sound: 'default',
        title: title,
        body: body,
        data: data,
        channelId: channelId,
        priority: 'high',
      });
    }

    if (messages.length === 0) {
      return { success: false, error: 'No valid tokens' };
    }

    return new Promise((resolve) => {
      const postData = JSON.stringify(messages);

      const options = {
        hostname: this.EXPO_PUSH_URL,
        port: 443,
        path: this.EXPO_PUSH_PATH,
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            console.log('[PUSH] Enviado a ' + messages.length + ' tokens. Status: ' + res.statusCode);
            console.log('[PUSH] Response:', JSON.stringify(result));
            resolve({
              success: res.statusCode === 200,
              http_code: res.statusCode,
              response: result
            });
          } catch (e) {
            resolve({ success: false, error: 'Parse error', raw: responseData });
          }
        });
      });

      req.on('error', (error) => {
        console.error('[PUSH] Error:', error.message);
        resolve({ success: false, error: error.message });
      });

      req.setTimeout(30000, () => {
        req.destroy();
        resolve({ success: false, error: 'Timeout' });
      });

      req.write(postData);
      req.end();
    });
  }

  // Obtener tokens de usuarios
  async getTokensByUserIds(userIds) {
    if (!userIds || userIds.length === 0) {
      return [];
    }

    try {
      const placeholders = userIds.map(() => '?').join(',');
      const [rows] = await db.execute(
        'SELECT token, user_id, device_type FROM push_tokens WHERE user_id IN (' + placeholders + ') AND is_active = 1',
        userIds
      );
      return rows;
    } catch (error) {
      console.error('[PUSH] Error getting tokens:', error);
      return [];
    }
  }

  // Enviar push a usuarios especificos
  async sendToUsers(userIds, title, body, data = {}, channelId = 'default') {
    const tokens = await this.getTokensByUserIds(userIds);

    if (tokens.length === 0) {
      console.log('[PUSH] No hay tokens registrados para usuarios:', userIds.join(', '));
      return { success: false, error: 'No tokens registered for users' };
    }

    console.log('[PUSH] Enviando a ' + tokens.length + ' dispositivos de ' + userIds.length + ' usuarios');
    return this.sendPush(tokens, title, body, data, channelId);
  }

  // Notificar nuevo mensaje de chat
  async notifyNewChatMessage(message, conversationId, offlineUserIds) {
    if (offlineUserIds.length === 0) {
      return;
    }

    const title = message.sender_name || 'Nuevo mensaje';
    const body = message.content.substring(0, 100);

    await this.sendToUsers(
      offlineUserIds,
      title,
      body,
      {
        type: 'chat_message',
        conversationId: conversationId,
        messageId: message.id,
        senderId: message.sender_id
      },
      'chat'
    );
  }

  // Notificar nuevo mensaje de soporte
  async notifySupportMessage(sessionId, customerName, messageContent, agentIds) {
    if (agentIds.length === 0) {
      return;
    }

    await this.sendToUsers(
      agentIds,
      'Soporte: ' + customerName,
      messageContent.substring(0, 100),
      {
        type: 'support_message',
        sessionId: sessionId,
        customerName: customerName
      },
      'support'
    );
  }

  // Notificar asignacion de tarea
  async notifyTaskAssignment(task, assigneeId) {
    await this.sendToUsers(
      [assigneeId],
      'Nueva tarea asignada',
      task.title,
      {
        type: 'task_assignment',
        taskId: task.id,
        projectId: task.project_id
      },
      'tasks'
    );
  }

  // Eliminar token invalido
  async removeInvalidToken(token) {
    try {
      await db.execute('DELETE FROM push_tokens WHERE token = ?', [token]);
      console.log('[PUSH] Token invalido eliminado:', token);
    } catch (error) {
      console.error('[PUSH] Error removing invalid token:', error);
    }
  }
}

module.exports = new PushService();
