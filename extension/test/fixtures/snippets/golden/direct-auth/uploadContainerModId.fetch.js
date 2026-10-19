// Replace ./file-to-upload with the path of the file to send.
// Replace the modId with the one from the record you read.
import { readFile } from "node:fs/promises";

const token = process.env.FM_TOKEN ?? "<session token>";
const form = new FormData();
form.append("upload", new Blob([await readFile("./file-to-upload")]), "file-to-upload");
const response = await fetch("https://fm.example.com/fmi/data/vLatest/databases/Sales%20DB/layouts/Contacts/records/42/containers/Photo/2?modId=<modId>", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${token}`
  },
  body: form,
});
const data = await response.json();