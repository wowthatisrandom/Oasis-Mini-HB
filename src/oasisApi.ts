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

// MQTT broker details from HA integration
const MQTT_HOST = 'mqtt.grounded.so';
const MQTT_PORT = 8084;
const MQTT_USERNAME = Buffer.from('YXBw', 'base64').toString('utf-8'); // "app"
const MQTT_PASSWORD = Buffer.from('UkVEQUNURUQ=', 'base64').toString('utf-8'); // "REDACTED"

export class OasisApi {
  private client: MqttClient | null = null;
  private readonly serial: string;
  private connected = false;
  private debugMode = false;  // Set to true for verbose logging
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

  constructor(serial: string, log?: (message: string, ...params: unknown[]) => void) {
    this.serial = serial.toUpperCase();
    this.log = log || null;
  }

  private debug(_message: string, ..._params: unknown[]) {
    // Debug logging disabled
  }

  private info(message: string, ...params: unknown[]) {
    // Always log important info
    if (this.log) {
      this.log(`[OasisAPI] ${message}`, ...params);
    } else {
      console.log(`[OasisAPI] ${message}`, ...params);
    }
  }

  async connect(): Promise<void> {
    if (this.connected && this.client) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      const url = `wss://${MQTT_HOST}:${MQTT_PORT}/mqtt`;

      if (this.debugMode) {
        this.info(`Connecting to MQTT broker: ${url}`);
        this.info(`Using serial: ${this.serial}`);
      }

      this.client = mqtt.connect(url, {
        username: MQTT_USERNAME,
        password: MQTT_PASSWORD,
        keepalive: 60,
        reconnectPeriod: 5000,
        connectTimeout: 30000,
        rejectUnauthorized: true,
        clean: true,  // Don't receive old retained messages
      });

      this.client.on('connect', () => {
        if (this.debugMode) {
          this.info('Connected to MQTT');
        }
        this.connected = true;

        // Subscribe to status updates
        const statusTopic = `${this.serial}/STATUS/#`;
        this.client!.subscribe(statusTopic, { qos: 1 }, (err) => {
          if (err) {
            this.info(`Subscribe failed: ${err.message}`);
            reject(err);
          } else {
            if (this.debugMode) {
              this.info('Subscribed');
            }
            resolve();
          }
        });
      });

      this.client.on('message', (topic, message) => {
        this.debug(`MQTT: ${topic} = ${message.toString().substring(0, 50)}`);
        this.handleMessage(topic, message.toString());
      });

      this.client.on('error', (err) => {
        this.info(`MQTT ERROR: ${err.message}`);
        reject(err);
      });

      this.client.on('close', () => {
        if (this.debugMode) {
          this.info('MQTT connection closed');
        }
        this.connected = false;
      });

      this.client.on('reconnect', () => {
        if (this.debugMode) {
          this.info('Reconnecting to MQTT broker...');
        }
      });
    });

    return this.connectionPromise;
  }

  private handleMessage(topic: string, message: string) {
    const parts = topic.split('/');
    if (parts.length < 3) return;

    const messageType = parts[2];

    // Debug logging removed - too spammy

    let statusChanged = false;
    const oldStatus = this.currentStatus.status;

    switch (messageType) {
      case 'OASIS_STATUS': {
        const statusCode = parseInt(message, 10);
        const newStatus = this.parseStatus(statusCode);
        if (this.debugMode) {
          this.info(`Status: ${statusCode} = ${newStatus}`);
        }
        if (this.currentStatus.status !== newStatus) {
          this.currentStatus.status = newStatus;
          statusChanged = true;
        }
        break;
      }
      case 'LED_BRIGHTNESS':
        this.currentStatus.brightness = parseInt(message, 10);
        this.currentStatus.led_on = this.currentStatus.brightness > 0;
        break;
      case 'LED_EFFECT_COLOR': {
        // Format: "r,g,b" or similar
        const colors = message.split(',').map(c => parseInt(c.trim(), 10));
        if (colors.length >= 3) {
          this.currentStatus.led_r = colors[0];
          this.currentStatus.led_g = colors[1];
          this.currentStatus.led_b = colors[2];
        }
        break;
      }
      case 'LED_EFFECT':
        this.currentStatus.led_effect = parseInt(message, 10);
        this.info(`LED Effect: ${this.currentStatus.led_effect}`);
        break;
      case 'OASIS_SPEEED': // Note: typo in original API
        this.currentStatus.speed = parseInt(message, 10);
        break;
      case 'FULLSTATUS':
        try {
          const data = JSON.parse(message);
          if (data.status !== undefined) {
            const newStatus = this.parseStatus(data.status);
            if (this.currentStatus.status !== newStatus) {
              this.currentStatus.status = newStatus;
              statusChanged = true;
              this.info(`Device status changed: ${oldStatus} -> ${newStatus}`);
            }
          }
          if (data.led_brightness !== undefined) {
            this.currentStatus.brightness = data.led_brightness;
          }
          if (data.led_r !== undefined) this.currentStatus.led_r = data.led_r;
          if (data.led_g !== undefined) this.currentStatus.led_g = data.led_g;
          if (data.led_b !== undefined) this.currentStatus.led_b = data.led_b;
        } catch {
          // Ignore JSON parse errors
        }
        break;
    }

    // Only notify callbacks when status actually changes or on LED updates
    if (statusChanged || messageType === 'LED_BRIGHTNESS' || messageType === 'LED_EFFECT_COLOR') {
      this.statusCallbacks.forEach(cb => cb(this.currentStatus));
    }
  }

  private parseStatus(code: number): string {
    // Corrected based on real device testing:
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
    };
    return statusMap[code] || 'UNKNOWN';
  }

  private async sendCommand(command: string): Promise<void> {
    // Wait for connection with retries
    let attempts = 0;
    const maxAttempts = 3;

    while (!this.connected && attempts < maxAttempts) {
      attempts++;
      this.debug(`Waiting for MQTT connection (attempt ${attempts})...`);
      await this.connect();
      if (!this.connected) {
        // Wait a bit before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!this.client || !this.connected) {
      this.info('ERROR: Not connected to MQTT broker');
      throw new Error('Not connected to MQTT broker');
    }

    const topic = `${this.serial}/COMMAND/CMD`;

    return new Promise((resolve, reject) => {
      this.client!.publish(topic, command, { qos: 1 }, (err) => {
        if (err) {
          this.info(`Command failed: ${command} - ${err.message}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  onStatusUpdate(callback: (status: OasisStatus) => void) {
    this.statusCallbacks.push(callback);
  }

  async getStatus(): Promise<OasisStatus> {
    // Just return cached status - don't send GETSTATUS as it may wake sleeping device
    return this.currentStatus;
  }

  async play(): Promise<void> {
    await this.sendCommand('CMDPLAY');
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
    // Clamp RGB values to 0-255
    r = Math.max(0, Math.min(255, Math.round(r)));
    g = Math.max(0, Math.min(255, Math.round(g)));
    b = Math.max(0, Math.min(255, Math.round(b)));

    // Convert RGB to hex color
    const color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

    // Use current values or defaults
    const ledEffect = effect ?? this.currentStatus.led_effect ?? 0;
    const ledSpeed = speed ?? 0;
    const ledBrightness = brightness ?? Math.round((this.currentStatus.brightness / 255) * 100);

    // Format: WRILED={effect};0;{color};{speed};{brightness}
    const command = `WRILED=${ledEffect};0;${color};${ledSpeed};${ledBrightness}`;
    await this.sendCommand(command);
  }

  async setLedBrightness(brightness: number): Promise<void> {
    // Brightness is 0-100 for the device
    brightness = Math.max(0, Math.min(100, Math.round(brightness)));

    // Get current color
    const r = this.currentStatus.led_r ?? 255;
    const g = this.currentStatus.led_g ?? 255;
    const b = this.currentStatus.led_b ?? 255;
    const color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

    const ledEffect = this.currentStatus.led_effect ?? 0;
    const ledSpeed = 0;

    // Format: WRILED={effect};0;{color};{speed};{brightness}
    const command = `WRILED=${ledEffect};0;${color};${ledSpeed};${brightness}`;
    await this.sendCommand(command);
  }

  async setLedEffect(effect: number): Promise<void> {
    const r = this.currentStatus.led_r ?? 255;
    const g = this.currentStatus.led_g ?? 255;
    const b = this.currentStatus.led_b ?? 255;
    const color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    const brightness = Math.round((this.currentStatus.brightness / 255) * 100);

    const command = `WRILED=${effect};0;${color};0;${brightness}`;
    await this.sendCommand(command);
  }

  isAwake(status: string): boolean {
    // BOOTING is included because device goes through BOOTING when waking up
    // BUSY is included because device may be busy processing after wake
    return status === 'PLAYING' || status === 'PAUSED' || status === 'STOPPED' ||
           status === 'CENTERING' || status === 'BOOTING' || status === 'BUSY';
  }

  isPlaying(status: string): boolean {
    return status === 'PLAYING';
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.end();
      this.client = null;
      this.connected = false;
      this.connectionPromise = null;
    }
  }
}
