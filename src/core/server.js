import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { HttpError, readJsonBody, requireExactFields, writeError, writeJson } from '../shared/http-json.js';
import { RequestConflictError, TaskService } from './task-service.js';

const FIXED_HOST = '127.0.0.1';
const FIXED_PORT = 4330;
const MESSAGE_FIELDS = Object.freeze(['requestId', 'channel', 'text', 'attachments']);
const HOOK_FIELDS = Object.freeze(['sessionId', 'taskId', 'toolName', 'toolInput', 'toolUseId']);
const APPROVAL_ACTION_FIELDS = Object.freeze(['action', 'approvalId', 'ownerId']);
const PASSWORD_FIELDS = Object.freeze(['ownerId', 'password']);

function constantTimeEqual(value, expected) {
  const actual = Buffer.from(typeof value === 'string' ? value : '', 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  const normalized = Buffer.alloc(wanted.length);
  actual.copy(normalized, 0, 0, wanted.length);
  return timingSafeEqual(normalized, wanted) && actual.length === wanted.length;
}

function validateConfiguration(config) {
  if (config?.host !== FIXED_HOST || config?.port !== FIXED_PORT) {
    throw new Error(`core server must bind exactly to ${FIXED_HOST}:${FIXED_PORT}`);
  }
  const names = ['telegram', 'web', 'admin', 'hook', 'weixin'];
  for (const name of names) {
    if (typeof config.clientKeys?.[name] !== 'string' || config.clientKeys[name].length === 0) {
      throw new Error(`core server requires a ${name} client key`);
    }
  }
  if (new Set(names.map((name) => config.clientKeys[name])).size !== names.length) {
    throw new Error('core server client keys must be distinct');
  }
}

function authenticate(request, keys) {
  const presented = request.headers['x-pi-control-key'];
  let actor = null;
  for (const [name, expected] of Object.entries(keys)) {
    if (constantTimeEqual(presented, expected)) actor = name;
  }
  if (actor === null) throw new HttpError(401, 'unauthorized', 'A valid client key is required');
  return actor;
}

function authorize(actor, allowed) {
  if (!allowed.includes(actor)) {
    throw new HttpError(403, 'forbidden', 'This client key cannot access the requested channel');
  }
}

function requireString(body, field) {
  if (typeof body[field] !== 'string' || body[field].length === 0) {
    throw new HttpError(400, 'invalid_field', `${field} must be a non-empty string`);
  }
}

function parseInteger(value, name, { minimum, maximum, defaultValue }) {
  if (value === null) return defaultValue;
  if (!/^\d+$/.test(value)) throw new HttpError(400, 'invalid_query', `${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, 'invalid_query', `${name} is outside the allowed range`);
  }
  return parsed;
}

function assertOnlyQueryParameters(url, allowed) {
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name)) throw new HttpError(400, 'unknown_query', `Unknown query parameter: ${name}`);
  }
}

async function optionalEmptyBody(request) {
  const length = Number(request.headers['content-length'] ?? 0);
  if (length === 0 && request.headers['transfer-encoding'] === undefined) return;
  const body = await readJsonBody(request);
  requireExactFields(body, { allowed: [], required: [] });
}

export function createCoreServer({ config, db, services = {} }) {
  validateConfiguration(config);
  const taskService = services.taskService ?? new TaskService(db);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${FIXED_HOST}:${FIXED_PORT}`);
      const actor = authenticate(request, config.clientKeys);

      if (url.pathname === '/v1/messages') {
        if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        authorize(actor, ['telegram', 'web', 'weixin']);
        assertOnlyQueryParameters(url, []);
        const body = requireExactFields(await readJsonBody(request), { allowed: MESSAGE_FIELDS });
        requireString(body, 'requestId');
        requireString(body, 'channel');
        requireString(body, 'text');
        if (!Array.isArray(body.attachments)) throw new HttpError(400, 'invalid_field', 'attachments must be an array');
        if (body.channel !== actor) throw new HttpError(403, 'forbidden', 'Client key does not match message channel');

        let task;
        try {
          task = taskService.submit(body);
        } catch (error) {
          if (error instanceof RequestConflictError) {
            throw new HttpError(409, error.code, error.message);
          }
          if (error instanceof TypeError) throw new HttpError(400, 'invalid_field', error.message);
          throw error;
        }
        writeJson(response, 202, { data: { taskId: task.id, state: task.state, eventCursor: task.eventCursor } });
        return;
      }

      if (url.pathname === '/v1/events') {
        if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        authorize(actor, ['telegram', 'web', 'admin']);
        assertOnlyQueryParameters(url, ['after', 'limit']);
        const after = parseInteger(url.searchParams.get('after'), 'after', { minimum: 0, maximum: Number.MAX_SAFE_INTEGER, defaultValue: 0 });
        const limit = parseInteger(url.searchParams.get('limit'), 'limit', { minimum: 1, maximum: 100, defaultValue: 100 });
        writeJson(response, 200, { data: taskService.listEvents(after, limit) });
        return;
      }

      const cancelMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
      if (cancelMatch) {
        if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        authorize(actor, ['telegram', 'web', 'admin']);
        assertOnlyQueryParameters(url, []);
        await optionalEmptyBody(request);
        let taskId;
        try {
          taskId = decodeURIComponent(cancelMatch[1]);
        } catch (error) {
          if (error instanceof URIError) throw new HttpError(400, 'invalid_path', 'Malformed task path');
          throw error;
        }
        const task = taskService.requestCancel(taskId);
        if (!task) throw new HttpError(404, 'task_not_found', 'Task not found');
        const data = { taskId: task.id, state: task.state };
        if (task.state === 'cancelling') {
          if (typeof services.claudeRunner?.cancelSafely !== 'function') {
            throw new HttpError(503, 'runner_unavailable', 'Cancellation is persisted but the active runner is unavailable');
          }
          data.runnerCancellation = services.claudeRunner.cancelSafely(taskId) ? 'signalled' : 'not_active';
        }
        writeJson(response, 202, { data });
        return;
      }

      const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
      if (taskMatch) {
        if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        authorize(actor, ['telegram', 'web', 'admin', 'weixin']);
        assertOnlyQueryParameters(url, []);
        let taskId;
        try {
          taskId = decodeURIComponent(taskMatch[1]);
        } catch (error) {
          if (error instanceof URIError) throw new HttpError(400, 'invalid_path', 'Malformed task path');
          throw error;
        }
        const task = taskService.get(taskId);
        if (!task || (actor === 'weixin' && task.source !== 'weixin')) {
          throw new HttpError(404, 'task_not_found', 'Task not found');
        }
        writeJson(response, 200, { data: {
          taskId: task.id, state: task.state, cancelRequested: task.cancelRequested,
          createdAt: task.createdAt, updatedAt: task.updatedAt, resultSummary: task.resultSummary,
        } });
        return;
      }

      if (url.pathname === '/v1/health') {
        if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        authorize(actor, ['telegram', 'web', 'admin', 'weixin']);
        assertOnlyQueryParameters(url, []);
        writeJson(response, 200, { data: { status: 'ok' } });
        return;
      }

      if (url.pathname === '/v1/hooks/pre-tool-use') {
        if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        authorize(actor, ['hook']);
        assertOnlyQueryParameters(url, []);
        const body = requireExactFields(await readJsonBody(request), { allowed: HOOK_FIELDS });
        for (const field of ['sessionId', 'taskId', 'toolName', 'toolUseId']) requireString(body, field);
        if (body.toolInput === null || typeof body.toolInput !== 'object' || Array.isArray(body.toolInput)) {
          throw new HttpError(400, 'invalid_field', 'toolInput must be an object');
        }
        const handler = services.preToolUse ?? services.hookService?.preToolUse?.bind(services.hookService);
        if (!handler) throw new HttpError(503, 'hook_unavailable', 'Hook service is unavailable');
        const result = await handler(body);
        writeJson(response, 200, { data: result });
        return;
      }

      if (url.pathname === '/v1/approvals/action') {
        if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        authorize(actor, ['telegram']);
        assertOnlyQueryParameters(url, []);
        const body = requireExactFields(await readJsonBody(request), { allowed: APPROVAL_ACTION_FIELDS });
        for (const field of ['action', 'approvalId', 'ownerId']) requireString(body, field);
        if (!['approve', 'cancel'].includes(body.action)) throw new HttpError(400, 'invalid_field', 'action must be approve or cancel');
        const handler = services.hookService?.handleApprovalAction?.bind(services.hookService);
        if (!handler) throw new HttpError(503, 'approval_unavailable', 'Approval service is unavailable');
        writeJson(response, 200, { data: await handler(body) });
        return;
      }

      if (url.pathname === '/v1/approvals/pending-password') {
        if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        authorize(actor, ['telegram']);
        assertOnlyQueryParameters(url, ['ownerId']);
        const ownerId = url.searchParams.get('ownerId');
        if (!ownerId) throw new HttpError(400, 'invalid_query', 'ownerId is required');
        const handler = services.hookService?.isPendingPassword?.bind(services.hookService);
        if (!handler) throw new HttpError(503, 'approval_unavailable', 'Approval service is unavailable');
        writeJson(response, 200, { data: { pending: Boolean(await handler(ownerId)) } });
        return;
      }

      if (url.pathname === '/v1/approvals/password') {
        if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        authorize(actor, ['telegram']);
        assertOnlyQueryParameters(url, []);
        const body = requireExactFields(await readJsonBody(request), { allowed: PASSWORD_FIELDS });
        for (const field of PASSWORD_FIELDS) requireString(body, field);
        const handler = services.hookService?.submitPassword?.bind(services.hookService);
        if (!handler) throw new HttpError(503, 'approval_unavailable', 'Approval service is unavailable');
        const result = await handler(body);
        writeJson(response, 200, { data: { ok: result?.ok === true } });
        return;
      }

      throw new HttpError(404, 'not_found', 'Endpoint not found');
    } catch (error) {
      writeError(response, error);
    }
  });

  const listen = server.listen.bind(server);
  server.listen = (...args) => {
    if (args.length === 0 || typeof args[0] === 'function') {
      return listen(FIXED_PORT, FIXED_HOST, ...args);
    }
    const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
    if (Number(options.port) !== FIXED_PORT || options.host !== FIXED_HOST) {
      throw new Error(`core server must bind exactly to ${FIXED_HOST}:${FIXED_PORT}`);
    }
    return listen(...args);
  };
  return server;
}
