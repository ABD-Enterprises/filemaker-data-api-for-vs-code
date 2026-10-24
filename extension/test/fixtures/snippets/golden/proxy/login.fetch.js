// Proxy profile: one POST to the proxy, which adds the FileMaker credentials itself.
const response = await fetch("https://proxy.example.com/filemaker", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <REDACTED>"
  },
  body: "{\"action\":\"createSession\",\"profile\":{\"id\":\"profile-proxy\",\"database\":\"Sales DB\",\"serverUrl\":\"https://fm.example.com\"},\"payload\":{}}",
});
const data = await response.json();