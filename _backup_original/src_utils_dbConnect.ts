import mongoose from "mongoose";

export async function connectToDB() {
    try{
        await mongoose.connect(process.env.MONGODB_URI).then((r:any)=> console.log("Connected to DB...")).catch((err:any)=>console.log(err));
    }
    catch(err:any){
        console.error(err);
    }
}