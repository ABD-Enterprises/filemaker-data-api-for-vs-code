// Proxy profile: one POST to the proxy, which adds the FileMaker credentials itself.
// Replace the modId with the one from the record you read.
const response = await fetch("https://proxy.example.com/filemaker", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <REDACTED>"
  },
  body: "{\"action\":\"editRecord\",\"profile\":{\"id\":\"profile-proxy\",\"database\":\"Sales DB\",\"serverUrl\":\"https://fm.example.com\"},\"payload\":{\"layout\":\"Contacts\",\"recordId\":\"42\",\"fieldData\":{\"Status\":\"Inactive\"},\"modId\":\"<modId>\"}}",
});
const data = await response.json();