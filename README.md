# LMS Cast Receiver

Custom Google Cast receiver for Logitech Media Server (LMS) with the beautiful roon-cast UI.

## Architecture

This receiver uses the **Cast Message Architecture**:
- Receiver is hosted on HTTPS (GitHub Pages)
- Receives ALL data via Cast messages (no HTTP requests)
- Server polls LMS and sends formatted NOW_PLAYING messages
- No mixed content issues

## Deployment

**Deployed at:** https://zekimust-a11y.github.io/lms-cast/

**Google Cast App ID:** 180705D2

## How It Works

1. **Server polls LMS** (every 2 seconds)
   - Gets current track info (title, artist, artwork)
   - Formats data as Roon-compatible NOW_PLAYING messages

2. **Server sends Cast messages**
   - Sends complete track data via Cast messages
   - No HTTP requests from receiver

3. **Receiver displays data**
   - Listens for NOW_PLAYING messages
   - Updates display with track info
   - Shows artwork and artist images

## Message Format

```javascript
{
  type: 'NOW_PLAYING',
  payload: {
    state: 'playing',  // or 'paused', 'stopped'
    seek_position: 125.5,  // current position in seconds
    now_playing: {
      one_line: { line1: 'Track Title' },
      two_line: { 
        line1: 'Track Title',
        line2: 'Artist Name'
      },
      three_line: {
        line1: 'Track Title',
        line2: 'Artist Name',
        line3: 'Album Name'
      },
      length: 245.3,  // duration in seconds
      image_keys: ['coverid']
    },
    image_url: 'http://lms:9000/music/coverid/cover.jpg',
    image_data: 'http://lms:9000/music/coverid/cover.jpg',
    artist_images: []  // Optional array of artist image URLs
  }
}
```

## Comparison with roon-cast

| Feature | roon-cast | lms-cast |
|---------|-----------|----------|
| Data Source | Roon Core | Logitech Media Server |
| Architecture | Cast Messages | Cast Messages |
| Receiver | Same UI | Same UI |
| Server | Polls Roon | Polls LMS |
| HTTPS | ✅ | ✅ |
| Mixed Content | ❌ None | ❌ None |

## Usage

1. Set Google Cast Console receiver URL to:
   ```
   https://zekimust-a11y.github.io/lms-cast/
   ```

2. Server will:
   - Poll LMS for track info
   - Format as NOW_PLAYING messages
   - Send via Cast messages

3. Receiver will:
   - Display track info
   - Update in real-time
   - Show artwork

## Cast Namespace

`urn:x-cast:com.zeki.rooncast`

(Same as roon-cast for compatibility)
