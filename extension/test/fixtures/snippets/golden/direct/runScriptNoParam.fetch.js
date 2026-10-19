const response = await fetch("https://fm.example.com/fmi/data/vLatest/databases/Sales%20DB/layouts/Contacts/script/Refresh", {
  method: "GET",
  headers: {
    "Authorization": "Bearer <REDACTED>"
  },
});
const data = await response.json();