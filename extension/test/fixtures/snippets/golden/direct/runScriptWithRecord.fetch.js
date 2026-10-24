const response = await fetch("https://fm.example.com/fmi/data/vLatest/databases/Sales%20DB/layouts/Contacts/records/42?script=Send%20Welcome&script.param=hi", {
  method: "GET",
  headers: {
    "Authorization": "Bearer <REDACTED>"
  },
});
const data = await response.json();