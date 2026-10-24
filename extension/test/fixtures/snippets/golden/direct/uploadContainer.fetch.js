// Replace ./file-to-upload with the path of the file to send.
import { readFile } from "node:fs/promises";

const form = new FormData();
form.append("upload", new Blob([await readFile("./file-to-upload")]), "file-to-upload");
const response = await fetch("https://fm.example.com/fmi/data/vLatest/databases/Sales%20DB/layouts/Contacts/records/42/containers/Photo/1", {
  method: "POST",
  headers: {
    "Authorization": "Bearer <REDACTED>"
  },
  body: form,
});
const data = await response.json();