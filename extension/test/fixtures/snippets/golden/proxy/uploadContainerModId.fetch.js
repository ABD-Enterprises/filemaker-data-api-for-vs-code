// Proxy profile: one POST to the proxy, which adds the FileMaker credentials itself.
// Fill in the file name and the base64 text of the file.
const response = await fetch("https://proxy.example.com/filemaker", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <REDACTED>"
  },
  body: "{\"action\":\"uploadContainer\",\"profile\":{\"id\":\"profile-proxy\",\"database\":\"Sales DB\",\"serverUrl\":\"https://fm.example.com\"},\"payload\":{\"layout\":\"Contacts\",\"recordId\":\"42\",\"fieldName\":\"Photo\",\"fieldRepetition\":2,\"modId\":\"<modId>\",\"fileName\":\"<file name>\",\"contentType\":\"application/octet-stream\",\"contentBase64\":\"<base64 of the file>\"}}",
});
const data = await response.json();