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

*   **Game Monitoring:**
    *   **Games to Monitor:** Configure a list of games to monitor.
    *   **Game App ID:** Stores the Steam App ID for each monitored game.
    *   **Game News:** Fetches and updates the latest news for each monitored game every 6 hours (4 times a day).
    *   **Game Name Suggestions:** If a game cannot be found (e.g., due to a typo), the adapter logs a warning and suggests up to 5 similar game names from the Steam app list.

*   **Recently Played Games:**
    *   **Fetches recently played games** every 15 minutes (configurable in the code).
    *   **recentlyPlayed** is also updated immediately whenever the `currentGame` changes.

*   **API Request Management:**
    *   **GetPlayerSummaries:** Requests player summaries at a configurable interval (minimum 15 seconds, default 60 seconds).
    *   **Daily Request Count:** Monitors the number of GetPlayerSummaries API requests to avoid exceeding the limit of 10,000 requests per day.
    *   **Automatic Reset:** Automatically resets the daily request count at 0:00 (midnight).
    *   **Buffer for Restarts:** Takes into account a buffer to ensure API requests during adapter restarts or connection interruptions.

## Configuration

1.  **Steam Name:** Enter your Steam username.
2.  **Steam API Key:** Enter your Steam API key. You can generate an API key [here](https://steamcommunity.com/dev/apikey).
3.  **Player summary interval:** Set how often to request player summaries (minimum 15 seconds).
4.  **Games to Monitor:** Add games to monitor.

## Usage

After installing and configuring the adapter, the Steam profile information, game news, recently played games, and API request statistics will be available as states in ioBroker.

## Changelog

### 0.2.1 (2025-04-16)
* (bloop16)
    * Fix APIRequest

### 0.2.0 (2025-04-16)
* (bloop16)
    * Added function to suggest up to 5 similar game names if a game cannot be found (typo-tolerant search and warning in log).

### 0.1.2 (2025-04-15)
* (bloop16)
    * Added configurable interval for GetPlayerSummaries (min 15s, default 60s)
    * Added fetching and updating of game news every 6 hours (4x per day)
    * Added fetching of recently played games every 15 minutes
    * Improved API request management and daily request counter reset
    * Cleaned up code and improved error handling

### 0.0.3 (2025-04-13)
* (bloop16)  
    * fixed state directory

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