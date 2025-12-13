# Network Intercept Chrome Extension

A powerful Chrome extension that allows you to intercept, modify, and delay network requests in real-time.

## Features

- **URL Pattern Matching**: Use regular expressions to target specific requests
- **Response Modification**: Change response body, status codes, and headers
- **Request Delay**: Add artificial delays to simulate slow network conditions
- **Rule Management**: Enable/disable rules individually
- **Easy-to-Use Interface**: Simple popup UI for managing intercept rules

## Installation

### From Source

1. Clone this repository or download the source code
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" and select the extension directory
5. The extension icon should appear in your Chrome toolbar

## Usage

### Getting Started

1. Click the extension icon in the Chrome toolbar
2. Toggle the switch to "Enabled" to start intercepting requests
3. Click "Add Rule" to create your first intercept rule

### Creating an Intercept Rule

1. **URL Pattern**: Enter a regular expression to match URLs
   - Example: `.*api\.example\.com.*` matches any URL containing "api.example.com"
   - Example: `.*\.json$` matches all requests ending with ".json"

2. **Status Code**: Set the HTTP status code (200, 404, 500, etc.)

3. **Delay (ms)**: Add a delay in milliseconds before the response is returned

4. **Response Body**: Provide custom response data
   - Can be JSON: `{"message": "Custom response"}`
   - Or plain text: `Hello World`

5. **Custom Headers**: Add or override response headers (JSON format)
   ```json
   {
     "Content-Type": "application/json",
     "X-Custom-Header": "value"
   }
   ```

### Managing Rules

- **Enable/Disable**: Click the checkmark button to toggle a rule on/off
- **Edit**: Modify existing rules by clicking the "Edit" button
- **Delete**: Remove rules with the "Delete" button

## Examples

### Example 1: Mock API Response

**URL Pattern**: `.*api\.example\.com/users.*`  
**Status Code**: 200  
**Response Body**:
```json
{
  "users": [
    {"id": 1, "name": "John Doe"},
    {"id": 2, "name": "Jane Smith"}
  ]
}
```

### Example 2: Simulate Slow Network

**URL Pattern**: `.*\.jpg$`  
**Delay**: 3000  
**Status Code**: 200  
(Leave response body empty to use original)

### Example 3: Return Error

**URL Pattern**: `.*api\.example\.com/error.*`  
**Status Code**: 500  
**Response Body**:
```json
{"error": "Internal Server Error"}
```

## How It Works

This extension uses Chrome's Debugger API to intercept network requests at a low level:

1. When enabled, the extension attaches the Chrome Debugger to the active tab
2. The `Fetch` domain is enabled to intercept all network requests
3. Each request is checked against your defined rules
4. Matching requests are fulfilled with your custom response
5. Non-matching requests continue normally

## Permissions

- **debugger**: Required to intercept and modify network requests
- **storage**: To save your intercept rules
- **tabs**: To access information about browser tabs
- **activeTab**: To interact with the currently active tab
- **host_permissions**: To intercept requests from all URLs

## Limitations

- Only works on tabs where the debugger can be attached
- Cannot intercept requests from Chrome's built-in pages (chrome://)
- Only one debugger can be attached to a tab at a time
- When enabled, the tab will show "Debugger attached" notification

## Development

### Project Structure

```
network-intercept/
├── manifest.json       # Extension configuration
├── background.js       # Service worker for request interception
├── popup.html          # Popup UI structure
├── popup.css           # Popup styles
├── popup.js            # Popup logic
├── icons/              # Extension icons
└── README.md           # Documentation
```

### Key Technologies

- Chrome Extension Manifest V3
- Chrome Debugger API
- Fetch Domain API
- Vanilla JavaScript (no frameworks)

## Troubleshooting

**Extension not intercepting requests?**
- Make sure the toggle is enabled
- Check that your URL pattern is correct (test with regex101.com)
- Ensure the rule is enabled (checkmark should be visible)

**"Debugger attached" notification won't go away?**
- This is expected behavior when the extension is enabled
- Disable the extension to remove the notification

**Changes not taking effect?**
- Try reloading the page after adding/modifying rules
- Check the browser console for error messages

## Privacy & Security

- This extension runs locally in your browser
- No data is sent to external servers
- Rules are stored locally using Chrome's storage API
- Only intercepts requests when explicitly enabled

## License

MIT License - Feel free to modify and distribute as needed.

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## Support

For issues, questions, or suggestions, please open an issue on the GitHub repository.
