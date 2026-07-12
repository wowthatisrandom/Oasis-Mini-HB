import mqtt, { MqttClient } from 'mqtt';

export interface OasisStatus {
  status: string;
  led_on: boolean;
  led_r: number;
  led_g: number;
  led_b: number;
  brightness: number;
  led_effect: number;
  speed: number;
}

// Grounded cloud endpoints (same ones the official Oasis app uses)
const API_BASE = 'https://app.grounded.so/api/v2';
const MQTT_URL = 'wss://mqtt.grounded.so:8084/mqtt';

// Re-mint the MQTT token this long before its exp claim.
const TOKEN_REFRESH_SKEW_MS = 30 * 60 * 1000;
// setTimeout stores its delay in a 32-bit signed int; longer delays overflow
// and fire immediately. MQTT tokens can have a ~30-day TTL, so clamp and re-arm.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_AUTH_RETRIES = 2;
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const PUBLISH_TIMEOUT_MS = 10_000;

export class OasisApi {
  private client: MqttClient | null = null;
  private readonly serial: string;
  private readonly email: string;
  private readonly password: string;
  private connected = false;
  private unauthorized = false;
  private shuttingDown = false;
  private debugMode = false;  // Set to true for verbose logging

  private accessToken: string | null = null;
  private mqttToken: string | null = null;
  private mqttTokenExpiresAt: number | null = null;  // epoch ms
  private authRetries = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  private currentStatus: OasisStatus = {
    status: 'UNKNOWN',
    led_on: true,
    led_r: 255,
    led_g: 255,
    led_b: 255,
    brightness: 255,
    led_effect: 0,
    speed: 50,
  };
  private statusCallbacks: ((status: OasisStatus) => void)[] = [];
  private connectionPromise: Promise<void> | null = null;
  private log: ((message: string, ...params: unknown[]) => void) | null = null;

  constructor(
    serial: string,
    email: string,
    password: string,
    log?: (message: string, ...params: unknown[]) => void,
  ) {
    this.serial = serial.toUpperCase();
    this.email = email;
    this.password = password;
    this.log = log || null;
  }

  private debug(message: string, ...params: unknown[]) {
    if (this.debugMode) {
      this.info(message, ...params);
    }
  }

  private info(message: string, ...params: unknown[]) {
    if (this.log) {
      this.log(`[OasisAPI] ${message}`, ...params);
    } else {
      console.log(`[OasisAPI] ${message}`, ...params);
    }
  }

  // ---------- Grounded authentication ----------

  private async login(): Promise<void> {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    if (res.status === 401 || res.status === 403 || res.status === 422) {
      this.unauthorized = true;
      throw new Error(`Oasis login rejected (${res.status}). Check the email/password in your plugin config.`);
    }
    if (!res.ok) {
      throw new Error(`Oasis login failed (${res.status})`);
    }
    const data = await res.json() as { access_token?: string };
    if (!data.access_token) {
      throw new Error('Oasis login returned no access token');
    }
    this.accessToken = data.access_token;
    this.debug('Logged in to Grounded API');
  }

  /**
   * Mint an MQTT JWT bound to this account's device ACL. The ACL is a
   * mint-time snapshot, so a device added to the account after minting
   * needs a fresh token.
   */
  private async mintMqttToken(): Promise<void> {
    if (!this.accessToken) {
      await this.login();
    }

    let res = await fetch(`${API_BASE}/auth/mqtt/login`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    // Bearer may have expired since the last launch — re-login once and retry.
    if (res.status === 401 || res.status === 403) {
      this.accessToken = null;
      await this.login();
      res = await fetch(`${API_BASE}/auth/mqtt/login`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
    }

    if (!res.ok) {
      throw new Error(`MQTT token mint failed (${res.status})`);
    }
    const data = await res.json() as { token?: string };
    if (!data.token || typeof data.token !== 'string') {
      throw new Error('MQTT token mint returned no token');
    }
    this.mqttToken = data.token;
    const exp = parseJwtExp(data.token);
    this.mqttTokenExpiresAt = exp ? exp * 1000 : null;
    this.debug(`MQTT token minted${exp ? `, expires ${new Date(exp * 1000).toISOString()}` : ''}`);
  }

  private async ensureMqttToken(): Promise<void> {
    if (this.mqttToken && this.mqttTokenExpiresAt) {
      const ttl = this.mqttTokenExpiresAt - Date.now();
      if (ttl > TOKEN_REFRESH_SKEW_MS) {
        return;
      }
    } else if (this.mqttToken && !this.mqttTokenExpiresAt) {
      return;
    }
    await this.mintMqttToken();
  }

  // ---------- Connection lifecycle ----------

  async connect(): Promise<void> {
    this.shuttingDown = false;
    if (this.connected && this.client) {
      return;
    }
    if (this.unauthorized) {
      throw new Error('Oasis credentials rejected — fix email/password in the plugin config and restart Homebridge');
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.openSession().finally(() => {
      this.connectionPromise = null;
    });
    return this.connectionPromise;
  }

  private async openSession(): Promise<void> {
    await this.ensureMqttToken();

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      this.debug(`Connecting to ${MQTT_URL} as ${this.email}`);

      const client = mqtt.connect(MQTT_URL, {
        username: this.email,
        password: this.mqttToken!,
        clientId: `${this.email};${Date.now()};hb`,
        protocolVersion: 5,
        keepalive: 60,
        connectTimeout: 30_000,
        // Token auth makes blind auto-reconnect harmful (it would replay a
        // possibly-expired token forever) — we manage reconnects ourselves.
        reconnectPeriod: 0,
        clean: true,
        rejectUnauthorized: true,
      });
      this.client = client;

      client.on('connect', () => {
        this.connected = true;
        this.authRetries = 0;
        this.reconnectAttempts = 0;
        this.info('Connected to Oasis cloud');

        client.subscribe(`${this.serial}/#`, { qos: 0 }, (err, granted) => {
          if (err) {
            this.info(`Subscribe failed: ${err.message}`);
            settle(err);
            return;
          }
          // MQTT 5 reports per-topic rejection via reason codes >= 128
          // (typically an ACL miss: the serial isn't on this account).
          const rejected = (granted ?? []).some((g) => {
            const rc = (g as { reasonCode?: number; qos: number }).reasonCode ?? g.qos;
            return typeof rc === 'number' && rc >= 128;
          });
          if (rejected) {
            const msg = `Subscribe to ${this.serial}/# rejected — is this serial registered to ${this.email}?`;
            this.info(msg);
            this.handleAuthFailure(msg);
            settle(new Error(msg));
            return;
          }
          this.debug(`Subscribed to ${this.serial}/#`);
          // Seed device state (same reads the official app issues on connect;
          // some firmware answers GETSTATUS= but not GETALL=).
          this.publish(`${this.serial}/COMMAND/CMD`, 'GETSTATUS=').catch(() => {});
          this.publish(`${this.serial}/COMMAND/CMD`, 'GETALL=').catch(() => {});
          settle();
        });

        this.scheduleTokenRefresh();
      });

      client.on('message', (topic, message) => {
        this.handleMessage(topic, message.toString());
      });

      client.on('error', (err) => {
        const msg = err.message || String(err);
        this.info(`MQTT error: ${msg}`);
        if (/not authorized|bad user name|bad authentication|unauthorized/i.test(msg)) {
          this.handleAuthFailure(msg);
        }
        settle(err);
      });

      client.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) {
          this.info('Disconnected, will reconnect');
        }
        this.scheduleReconnect();
      });
    });
  }

  private handleAuthFailure(reason: string) {
    this.authRetries += 1;
    // Drop the token — the next attempt mints fresh credentials.
    this.mqttToken = null;
    this.mqttTokenExpiresAt = null;

    if (this.authRetries > MAX_AUTH_RETRIES) {
      this.unauthorized = true;
      this.info(`Giving up after ${this.authRetries} auth failures (${reason}). ` +
        'Check the email/password in your plugin config, then restart Homebridge.');
      this.teardownClient();
      return;
    }
    this.info(`Auth failure (${reason}), re-minting token (attempt ${this.authRetries}/${MAX_AUTH_RETRIES})`);
    this.teardownClient();
    this.scheduleReconnect(RECONNECT_BASE_MS);
  }

  private scheduleReconnect(delayMs?: number) {
    if (this.unauthorized || this.shuttingDown || this.reconnectTimer || this.connectionPromise) {
      return;
    }
    this.reconnectAttempts += 1;
    const backoff = Math.min(
      RECONNECT_MAX_MS,
      delayMs ?? RECONNECT_BASE_MS * this.reconnectAttempts,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.teardownClient();
      this.connect().catch((err) => {
        this.debug(`Reconnect failed: ${(err as Error).message}`);
        this.scheduleReconnect();
      });
    }, backoff);
  }

  private scheduleTokenRefresh() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (!this.mqttTokenExpiresAt) {
      return;
    }
    const fireAt = this.mqttTokenExpiresAt - TOKEN_REFRESH_SKEW_MS;
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(60_000, fireAt - Date.now()));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      // Woke early because the delay was clamped — re-arm, don't rotate yet.
      if (Date.now() < fireAt) {
        this.scheduleTokenRefresh();
        return;
      }
      this.info('Rotating MQTT token before expiry');
      this.teardownClient();
      this.connect().catch((err) => {
        this.debug(`Token rotation reconnect failed: ${(err as Error).message}`);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private teardownClient() {
    this.connected = false;
    if (this.client) {
      // Detach handlers first: the dead client's close event must not
      // schedule a reconnect on behalf of a connection we're replacing.
      this.client.removeAllListeners();
      try {
        this.client.end(true);
      } catch {
        // ignore
      }
      this.client = null;
    }
  }

  // ---------- Message handling ----------

  private handleMessage(topic: string, message: string) {
    const parts = topic.split('/');
    if (parts.length < 2 || parts[0] !== this.serial) {
      return;
    }
    // Our own publishes (and the app's) echo back on COMMAND/* — not state.
    if (parts[1] === 'COMMAND') {
      return;
    }

    const key = parts[1] === 'STATUS' && parts.length >= 3 ? parts[2] : parts[1];
    this.debug(`MQTT: ${topic} = ${message.substring(0, 50)}`);

    const oldStatus = this.currentStatus.status;
    const ledChanged = this.applyKey(key, message);
    const statusChanged = this.currentStatus.status !== oldStatus;

    if (statusChanged) {
      this.info(`Device status changed: ${oldStatus} -> ${this.currentStatus.status}`);
    }
    if (statusChanged || ledChanged) {
      this.statusCallbacks.forEach(cb => cb(this.currentStatus));
    }
  }

  /** Apply one state key. Returns true if an LED-related field changed. */
  private applyKey(key: string, value: string): boolean {
    switch (key) {
      case 'OASIS_STATUS': {
        const statusCode = parseInt(value, 10);
        if (!isNaN(statusCode)) {
          this.currentStatus.status = this.parseStatus(statusCode);
        }
        return false;
      }
      case 'LED_BRIGHTNESS': {
        const brightness = parseInt(value, 10);
        if (!isNaN(brightness)) {
          this.currentStatus.brightness = brightness;
          this.currentStatus.led_on = brightness > 0;
        }
        return true;
      }
      case 'LED_EFFECT_COLOR':
      case 'LED_EFFECT_PARAM': { // firmware 3.x echoes the colour on this key
        const rgb = parseColor(value);
        if (rgb) {
          this.currentStatus.led_r = rgb.r;
          this.currentStatus.led_g = rgb.g;
          this.currentStatus.led_b = rgb.b;
        }
        return true;
      }
      case 'LED_EFFECT': {
        const effect = parseInt(value, 10);
        if (!isNaN(effect) && effect !== this.currentStatus.led_effect) {
          this.currentStatus.led_effect = effect;
          this.info(`LED Effect: ${effect}`);
        }
        return false;
      }
      case 'OASIS_SPEEED': // Note: typo is in the device firmware
      case 'OASIS_SPEED': {
        const speed = parseInt(value, 10);
        if (!isNaN(speed)) {
          this.currentStatus.speed = speed;
        }
        return false;
      }
      case 'FULLSTATUS':
        return this.parseFullStatus(value);
      default:
        return false;
    }
  }

  /**
   * FULLSTATUS (the reply to GETALL=) is a semicolon-separated positional
   * payload. Firmware 3.x reordered the fields; the LED colour ('#RRGGBB')
   * is the only self-identifying field, so use its position to pick the map.
   */
  private parseFullStatus(value: string): boolean {
    const parts = value.split(';');
    const firstPart = parts[0]?.trim() ?? '';
    if (parts.length <= 1 || firstPart.includes('=') || firstPart.includes(':')) {
      return false;
    }

    const isHexColour = (part?: string) => !!part && part.trim().startsWith('#');
    const keys = isHexColour(parts[10]) ? FULLSTATUS_KEYS_V3
      : isHexColour(parts[7]) ? FULLSTATUS_KEYS_LEGACY
        : FULLSTATUS_KEYS_V3;

    let ledChanged = false;
    for (let i = 0; i < parts.length && i < keys.length; i++) {
      const key = keys[i];
      const val = parts[i].trim();
      if (key && val) {
        if (this.applyKey(key, val)) {
          ledChanged = true;
        }
      }
    }
    return ledChanged;
  }

  private parseStatus(code: number): string {
    const statusMap: Record<number, string> = {
      0: 'BOOTING',
      1: 'ERROR',
      2: 'STOPPED',
      3: 'CENTERING',
      4: 'PLAYING',
      5: 'PAUSED',
      6: 'SLEEP',
      7: 'UPDATING',
      8: 'DOWNLOADING',
      9: 'BUSY',
      10: 'LIVE',
      11: 'UPGRADING',
      13: 'DOWNLOADING', // firmware 3.x: fetching the next track mid-queue
    };
    return statusMap[code] || 'UNKNOWN';
  }

  // ---------- Commands ----------

  /**
   * Reads (GETSTATUS=/GETALL=) go to COMMAND/CMD, mutations to COMMAND/CTL —
   * matching the official app's captured behavior.
   */
  private commandTopic(command: string): string {
    if (command === 'GETSTATUS' || command === 'GETSTATUS=' || command === 'GETALL=') {
      return `${this.serial}/COMMAND/CMD`;
    }
    return `${this.serial}/COMMAND/CTL`;
  }

  private async sendCommand(command: string): Promise<void> {
    let attempts = 0;
    const maxAttempts = 3;

    while (!this.connected && attempts < maxAttempts) {
      attempts++;
      this.debug(`Waiting for MQTT connection (attempt ${attempts})...`);
      try {
        await this.connect();
      } catch (err) {
        this.debug(`Connect attempt failed: ${(err as Error).message}`);
      }
      if (!this.connected) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!this.client || !this.connected) {
      this.info('ERROR: Not connected to MQTT broker');
      throw new Error('Not connected to MQTT broker');
    }

    return this.publish(this.commandTopic(command), command);
  }

  private publish(topic: string, payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => {
        settle(new Error(`publish timeout (${payload.split('=')[0]})`));
      }, PUBLISH_TIMEOUT_MS);

      this.client!.publish(topic, payload, { qos: 1 }, (err) => {
        if (err) {
          this.info(`Command failed: ${payload} - ${err.message}`);
          settle(err as Error);
        } else {
          settle();
        }
      });
    });
  }

  onStatusUpdate(callback: (status: OasisStatus) => void) {
    this.statusCallbacks.push(callback);
  }

  async getStatus(): Promise<OasisStatus> {
    // Return cached status; state stays fresh via the serial/# subscription.
    return this.currentStatus;
  }

  async play(): Promise<void> {
    await this.sendCommand('CMDPLAY=');
  }

  async pause(): Promise<void> {
    await this.sendCommand('CMDPAUSE');
  }

  async sleep(): Promise<void> {
    await this.sendCommand('CMDSLEEP');
  }

  async wake(): Promise<void> {
    await this.sendCommand('CMDBOOT');
  }

  /**
   * Set LED with full control
   * Command format: WRILED={effect};0;{color};{speed};{brightness}
   * @param r Red 0-255
   * @param g Green 0-255
   * @param b Blue 0-255
   * @param brightness 0-100 (device scale)
   * @param effect LED effect number (0=Solid)
   * @param speed LED speed (-90 to 90, 0 for solid)
   */
  async setLed(r: number, g: number, b: number, brightness?: number, effect?: number, speed?: number): Promise<void> {
    r = Math.max(0, Math.min(255, Math.round(r)));
    g = Math.max(0, Math.min(255, Math.round(g)));
    b = Math.max(0, Math.min(255, Math.round(b)));

    const color = toHexColor(r, g, b);
    const ledEffect = effect ?? this.currentStatus.led_effect ?? 0;
    const ledSpeed = speed ?? 0;
    const ledBrightness = brightness ?? Math.round((this.currentStatus.brightness / 255) * 100);

    await this.sendCommand(`WRILED=${ledEffect};0;${color};${ledSpeed};${ledBrightness}`);
  }

  async setLedBrightness(brightness: number): Promise<void> {
    // Brightness is 0-100 for the device
    brightness = Math.max(0, Math.min(100, Math.round(brightness)));

    const color = toHexColor(
      this.currentStatus.led_r ?? 255,
      this.currentStatus.led_g ?? 255,
      this.currentStatus.led_b ?? 255,
    );
    const ledEffect = this.currentStatus.led_effect ?? 0;

    await this.sendCommand(`WRILED=${ledEffect};0;${color};0;${brightness}`);
  }

  async setLedEffect(effect: number): Promise<void> {
    const color = toHexColor(
      this.currentStatus.led_r ?? 255,
      this.currentStatus.led_g ?? 255,
      this.currentStatus.led_b ?? 255,
    );
    const brightness = Math.round((this.currentStatus.brightness / 255) * 100);

    await this.sendCommand(`WRILED=${effect};0;${color};0;${brightness}`);
  }

  isAwake(status: string): boolean {
    // BOOTING is included because device goes through BOOTING when waking up
    // BUSY is included because device may be busy processing after wake
    return status === 'PLAYING' || status === 'PAUSED' || status === 'STOPPED' ||
           status === 'CENTERING' || status === 'BOOTING' || status === 'BUSY' ||
           status === 'DOWNLOADING';
  }

  isPlaying(status: string): boolean {
    return status === 'PLAYING';
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.teardownClient();
    this.connectionPromise = null;
  }
}

// Positional index → state key for FULLSTATUS, firmware 3.x layout.
// Verified against a live device on 3.17:
//   4;0;400;<joblist>;19;45194;23;0;0;100;#FFEE00;0;0;200;1;0;6;1;3.17
const FULLSTATUS_KEYS_V3: (string | null)[] = [
  'OASIS_STATUS',      // 0
  null,                // 1
  'OASIS_SPEEED',      // 2
  null,                // 3 (JOBLIST)
  null,                // 4 (CURRENTJOB)
  null,                // 5 (CURRENTLINE)
  null,                // 6
  null,                // 7
  null,                // 8
  null,                // 9
  'LED_EFFECT_COLOR',  // 10
  'LED_EFFECT',        // 11
  null,                // 12
  'LED_BRIGHTNESS',    // 13
  null,                // 14 (AUTO_CLEAN)
  null,                // 15 (REPEAT_JOB)
  null,                // 16 (WAIT_AFTER_JOB)
  null,                // 17
  null,                // 18 (SOFTWARE_VER)
];

// Legacy layout, verified against firmware 2.80.
const FULLSTATUS_KEYS_LEGACY: (string | null)[] = [
  'OASIS_STATUS',      // 0
  null,                // 1 (CURRENTJOB)
  'OASIS_SPEEED',      // 2
  null,                // 3 (JOBLIST)
  null,                // 4 (AUTO_CLEAN)
  null,                // 5 (CURRENTLINE)
  'LED_EFFECT',        // 6
  'LED_EFFECT_COLOR',  // 7
  null,                // 8 (LED_SPEED)
  'LED_BRIGHTNESS',    // 9
  null,                // 10
  null,                // 11
  null,                // 12
  null,                // 13
  null,                // 14 (REPEAT_JOB)
  null,                // 15 (OASIS_ERROR)
  null,                // 16 (WAIT_AFTER_JOB)
  null,                // 17
  null,                // 18 (SOFTWARE_VER)
];

/** Parse '#RRGGBB' (device format) or 'r,g,b' into RGB components. */
function parseColor(value: string): { r: number; g: number; b: number } | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('#') && trimmed.length >= 7) {
    const r = parseInt(trimmed.slice(1, 3), 16);
    const g = parseInt(trimmed.slice(3, 5), 16);
    const b = parseInt(trimmed.slice(5, 7), 16);
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
      return { r, g, b };
    }
    return null;
  }
  const colors = trimmed.split(',').map(c => parseInt(c.trim(), 10));
  if (colors.length >= 3 && colors.every(c => !isNaN(c))) {
    return { r: colors[0], g: colors[1], b: colors[2] };
  }
  return null;
}

function toHexColor(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function parseJwtExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}
