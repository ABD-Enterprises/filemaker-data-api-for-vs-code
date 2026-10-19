// Proxy profile: one POST to the proxy, which adds the FileMaker credentials itself.
// Replace the modId with the one from the record you read.
const token = process.env.FM_PROXY_API_KEY ?? "<proxy api key>";
const response = await fetch("https://proxy.example.com/filemaker", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  },
  body: "{\"action\":\"editRecord\",\"profile\":{\"id\":\"profile-proxy\",\"database\":\"Sales DB\",\"serverUrl\":\"https://fm.example.com\"},\"payload\":{\"layout\":\"Contacts\",\"recordId\":\"42\",\"fieldData\":{\"Status\":\"Inactive\"},\"modId\":\"<modId>\"}}",
});
const data = await response.json();