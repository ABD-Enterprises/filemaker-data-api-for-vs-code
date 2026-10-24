const response = await fetch("https://fm.example.com/fmi/data/vLatest/databases/Sales%20DB/layouts/Contacts/_find", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <REDACTED>"
  },
  body: "{\"query\":[{\"City\":\"Portland\",\"Status\":\"==Active\"},{\"City\":\"Seattle\",\"omit\":\"true\"}],\"sort\":[{\"fieldName\":\"Name\",\"sortOrder\":\"ascend\"}],\"limit\":25,\"offset\":26}",
});
const data = await response.json();