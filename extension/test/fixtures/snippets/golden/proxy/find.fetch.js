// Proxy profile: one POST to the proxy, which adds the FileMaker credentials itself.
const response = await fetch("https://proxy.example.com/filemaker", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <REDACTED>"
  },
  body: "{\"action\":\"findRecords\",\"profile\":{\"id\":\"profile-proxy\",\"database\":\"Sales DB\",\"serverUrl\":\"https://fm.example.com\"},\"payload\":{\"layout\":\"Contacts\",\"body\":{\"query\":[{\"City\":\"Portland\",\"Status\":\"==Active\"},{\"City\":\"Seattle\",\"omit\":\"true\"}],\"sort\":[{\"fieldName\":\"Name\",\"sortOrder\":\"ascend\"}],\"limit\":25,\"offset\":26}}}",
});
const data = await response.json();