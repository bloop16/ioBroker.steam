![Logo](admin/steam.png)

# ioBroker.steam

[![NPM version](https://img.shields.io/npm/v/iobroker.steam.svg)](https://www.npmjs.com/package/iobroker.steam)
[![Downloads](https://img.shields.io/npm/dm/iobroker.steam.svg)](https://www.npmjs.com/package/iobroker.steam)
![Number of Installations](https://iobroker.live/badges/steam-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/steam-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.steam.png?downloads=true)](https://nodei.co/npm/iobroker.steam/)

## ioBroker.steam

This adapter allows you to integrate information from the Steam API into your ioBroker system. 

## Features

*   **Steam Profile Information:**
    *   **Player Name:** Displays the current Steam name of the player.
    *   **Profile URL:** Provides the URL to the Steam profile.
    *   **Avatar URL:** Displays the URL to the player's avatar.
    *   **Player State:** Displays the current state of the player (e.g., Online, Ingame, Away).
    *   **Game Extra Info:** Displays information about the currently played game (if available).
    *   **Steam ID64:** The unique 64-bit Steam ID of the user.

*   **API Request Management:**
    *   **Daily Request Count:** Monitors the number of API requests to avoid exceeding the limit of 10,000 requests per day.
    *   **Automatic Reset:** Automatically resets the daily request count at 0:00 (midnight).
    *   **Buffer for Restarts:** Takes into account a buffer to ensure API requests during adapter restarts or connection interruptions.

## Configuration

1.  **Steam Name:** Enter your Steam username.
2.  **Steam API Key:** Enter your Steam API key. You can generate an API key [here](https://steamcommunity.com/dev/apikey).

## Usage

After installing and configuring the adapter, the Steam profile information and API request statistics will be available as states in ioBroker.

## Changelog

### **WORK IN PROGRESS**

### 0.0.2 (2025-04-13)
* (bloop16) First working Version
    * Steam profile information integration
    * API request management with daily limits
    * Automatic reset of request counter
    * Secure API key storage

## License
MIT License

Copyright (c) 2025 bloop16 <bloop16@hotmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.