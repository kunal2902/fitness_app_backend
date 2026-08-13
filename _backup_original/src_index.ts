import express from 'express';
import {connectToDB} from "./utils/dbConnect";
const app = express();
const port = 3000;

connectToDB().then(r => console.log("Connection established")).catch((err:any)=>console.log(err));

app.use(express.json());

app.use("/api", routes)

app.listen(port, () => {
    console.log(`Server started on port ${port}`);
})