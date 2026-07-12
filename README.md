# Homebridge Oasis Mini

A [Homebridge](https://homebridge.io) plugin that integrates the [Oasis Mini](https://www.theoasismini.com/) kinetic sand table into Apple HomeKit, allowing you to control your sand table via Siri and the Home app.

> **v2.0.0 breaking change:** the Oasis cloud retired anonymous access and now requires signing in with your Oasis account. Add `email` and `password` to your plugin config (see [Configuration](#configuration)) — v1.x can no longer connect.

The plugin supports **multiple tables** on the same Oasis account — each table gets its own full set of HomeKit accessories (see [Multiple Tables](#multiple-tables)).

## Features

This plugin creates four separate HomeKit accessories for comprehensive control:

| Accessory | Type | Description |
|-----------|------|-------------|
| **Power** | Switch | Wake/sleep control - turn your Oasis Mini on and off |
| **Drawing** | Switch | Play/pause control - start and stop the current pattern |
| **Light** | Lightbulb | Full RGB LED control with brightness, hue, and saturation |
| **LED Effect** | Television | Select from 43 different LED light effects |

### LED Effects

The plugin supports all 43 built-in LED effects:

<details>
<summary>Click to view all effects</summary>

| # | Effect | # | Effect |
|---|--------|---|--------|
| 0 | Solid | 22 | Gradient Cycle |
| 1 | Rainbow | 23 | Rainbow Runner |
| 2 | Rainbow Glitter | 24 | Twinkle Random |
| 3 | Confetti | 25 | Two Color Chase |
| 4 | Sinelon | 26 | Multi Color Chase |
| 5 | BPM | 27 | Breathing |
| 6 | Juggle | 28 | Hue Breathing |
| 7 | Theater | 29 | Fire |
| 8 | Theater Rainbow | 30 | Ice |
| 9 | Color Wipe | 31 | Ocean |
| 10 | Random Color Wipe | 32 | Lava |
| 11 | Single Sparkle | 33 | Forest |
| 12 | Multi Sparkle | 34 | Party |
| 13 | Flash | 35 | Fairy |
| 14 | Rainbow Flash | 36 | Candy Cane |
| 15 | Christmas | 37 | Hanukkah |
| 16 | Holi | 38 | Kwanzaa |
| 17 | Comet | 39 | Valentine |
| 18 | Bouncing Ball | 40 | Independence |
| 19 | Multi Bouncing Ball | 41 | St Patrick |
| 20 | Noise | 42 | Halloween |
| 21 | Color Wave | | |

</details>

## Requirements

- [Homebridge](https://homebridge.io) v1.6.0 or later
- Node.js v18.0.0 or later
- An Oasis Mini sand table with network connectivity
- Your Oasis Mini device serial number
- Your Oasis account email and password (the login you use in the official Oasis app)

## Installation

### Using Homebridge UI (Recommended)

1. Open the Homebridge UI
2. Go to the **Plugins** tab
3. Search for `homebridge-oasis-mini`
4. Click **Install**

### Using npm

```bash
npm install -g homebridge-oasis-mini
```

## Configuration

### Using Homebridge UI

1. Open the Homebridge UI
2. Go to **Plugins** > **Homebridge Oasis Mini**
3. Click **Settings**
4. Enter your device serial number and your Oasis account email and password
5. Click **Save**

### Manual Configuration

Add the following to your `config.json`:

```json
{
  "platforms": [
    {
      "platform": "OasisMini",
      "name": "Oasis Mini",
      "serial": "YOUR_SERIAL_NUMBER",
      "email": "you@example.com",
      "password": "YOUR_OASIS_PASSWORD",
      "pollingInterval": 30
    }
  ]
}
```

### Configuration Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `platform` | Yes | `"OasisMini"` | Must be `"OasisMini"` |
| `email` | Yes | - | Your Oasis account email (same login as the official app) |
| `password` | Yes | - | Your Oasis account password |
| `serial` | Yes* | - | Your device serial number (e.g., `OM000000000`) |
| `tables` | Yes* | - | Array of `{ "serial", "name" }` for multiple tables |
| `name` | No | `"Oasis Mini"` | Display name in HomeKit |
| `pollingInterval` | No | `30` | Status polling interval in seconds (5-300) |

\* Provide either a single `serial` or a `tables` array (or both — duplicates are ignored).

### Multiple Tables

If you have more than one table on your Oasis account, list them under
`tables`. Each table gets its own Power, Drawing, Light, and LED Effect
accessories:

```json
{
  "platforms": [
    {
      "platform": "OasisMini",
      "name": "Oasis Mini",
      "email": "you@example.com",
      "password": "YOUR_OASIS_PASSWORD",
      "tables": [
        { "serial": "OM000000000", "name": "Living Room Table" },
        { "serial": "ST000000000", "name": "Side Table" }
      ]
    }
  ]
}
```

All tables must be registered to the same Oasis account (the one in
`email`). `name` is optional — unnamed tables are numbered
("Oasis Mini", "Oasis Mini 2", ...).

### Why Does the Plugin Need My Oasis Login?

The Oasis cloud (run by Grounded, the maker of Oasis Mini) requires every
client to sign in with an account. The plugin uses your credentials to:

1. Sign in to the official Oasis API (`app.grounded.so`) — the same endpoint
   the official app uses
2. Request a short-lived access token that is scoped to **only the devices on
   your account**
3. Connect to the Oasis cloud with that token

Your email and password are stored **only** in your local Homebridge
`config.json` and are sent **only** to the official Oasis cloud over HTTPS.
They are never sent to any third party, and the plugin has no telemetry.
The access token is kept in memory and refreshed automatically before it
expires. If you're uncomfortable using your main account, you can create a
second Oasis account and share/register the device to it.

**Important:** the device serial you configure must be registered to the
account you sign in with (check the Oasis app under **Settings**). The
device-scoped token only grants access to devices on that account.

### Finding Your Serial Number

Your Oasis Mini serial number can be found:
- On a sticker on the bottom of your device
- In the Oasis app under **Settings**

The serial number format is typically `OM` followed by numbers (e.g., `OM000000000`).

## Usage

Once configured, four accessories will appear in your Home app:

### Power Control
- **ON**: Wakes the device from sleep
- **OFF**: Puts the device to sleep

### Drawing Control
- **ON**: Starts/resumes the current pattern
- **OFF**: Pauses the current pattern

### Light Control
- Toggle the LED ring on/off
- Adjust brightness (0-100%)
- Change color using hue and saturation

### LED Effect Selector
- Appears as a TV accessory in HomeKit
- Use the input selector to choose between 43 LED effects
- The current effect is shown as the active input

## Siri Commands

Example voice commands:

- "Hey Siri, turn on the Oasis Mini"
- "Hey Siri, pause the Oasis Mini Drawing"
- "Hey Siri, set the Oasis Mini Light to blue"
- "Hey Siri, set the Oasis Mini Light to 50%"
- "Hey Siri, turn off the Oasis Mini Light"

### Siri Control for LED Effects

The LED Effect selector uses a Television service, which doesn't support direct Siri voice commands for switching effects. However, you can use **Apple Shortcuts** to create Siri-enabled commands for your favorite effects:

1. Open the **Shortcuts** app on your iPhone/iPad
2. Tap **+** to create a new shortcut
3. Add action → **Home** → **Control [your home name]**
4. Select **Oasis Mini LED Effect**
5. Choose the effect you want (e.g., Rainbow)
6. Tap the shortcut name at the top and rename it (e.g., "Oasis Rainbow")
7. Save the shortcut

Now you can say **"Hey Siri, Oasis Rainbow"** to activate that effect.

Repeat for any other effects you want to control by voice.

## How It Works

The plugin communicates with your Oasis Mini via MQTT over WebSocket. It connects to the same cloud service used by the official Oasis app, so no local network configuration or port forwarding is required.

The plugin:
1. Signs in to the Oasis API with your account and obtains a device-scoped access token
2. Connects to the Oasis MQTT broker with that token and subscribes to your device's updates
3. Requests a full status snapshot on connect, then receives real-time updates
4. Sends commands when you interact with HomeKit controls
5. Automatically refreshes the token before it expires and reconnects with backoff if the connection drops

## Troubleshooting

### "Oasis login rejected" / "auth failure" in the logs

1. Double-check the `email` and `password` in your plugin config — they must
   match the login you use in the official Oasis app
2. If you recently changed your Oasis password, update the plugin config
3. After fixing credentials, restart Homebridge (the plugin stops retrying
   after repeated auth failures to avoid locking your account)

### "Subscribe rejected" in the logs

The device serial isn't registered to the account you signed in with. Open
the official Oasis app with that account and confirm the device appears
there, and that the serial in the plugin config matches exactly.

### Device not responding

1. Ensure your Oasis Mini is powered on and connected to WiFi
2. Verify the serial number is correct (check the Oasis app)
3. Check the Homebridge logs for connection errors
4. Restart Homebridge

### Status not updating

- The plugin polls for status updates based on `pollingInterval`
- Real-time updates are received via MQTT when available
- Try reducing the polling interval for faster updates

### Accessories not appearing in HomeKit

1. Restart Homebridge
2. Remove and re-add the Homebridge bridge in HomeKit
3. Check that the plugin is configured correctly

### Debug Logging

Enable debug logging in Homebridge to see detailed plugin activity:

```bash
DEBUG=* homebridge
```

## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/wowthatisrandom/Oasis-Mini-HB.git
cd homebridge-oasis-mini

# Install dependencies
npm install

# Build the plugin
npm run build

# Link for local development
npm link
```

### Available Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run watch` | Watch mode for development |
| `npm run lint` | Run ESLint |
| `npm run clean` | Remove the dist folder |

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This plugin is not affiliated with, endorsed by, or connected to Grounded LLC, the makers of Oasis Mini. Use at your own risk.

## Acknowledgments

- [Homebridge](https://homebridge.io) for the amazing home automation platform
- The Oasis Mini team for creating a beautiful product
