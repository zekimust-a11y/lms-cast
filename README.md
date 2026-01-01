# LMS Cast Receiver

Custom Chromecast receiver for displaying "Now Playing" information from Logitech Media Server (LMS).

## Features

- Beautiful full-screen display with album artwork
- Artist background images from TheAudioDB
- Live progress bar and time display
- Rotating artist images every 20 seconds
- Polls LMS directly for track information

## Receiver URL

https://zekimust-a11y.github.io/lms-cast

## Cast App ID

180705D2

## Usage

Configure this URL in your Google Cast Developer Console as the receiver application URL.
The receiver will automatically poll LMS for now-playing data when loaded.

## Query Parameters

- `host` - LMS server IP (default: 192.168.0.19)
- `port` - LMS server port (default: 9000)
- `player` - LMS player ID (required for specific player)

Example:
```
https://zekimust-a11y.github.io/lms-cast?host=192.168.0.19&port=9000&player=00:30:18:0d:62:1b
```
