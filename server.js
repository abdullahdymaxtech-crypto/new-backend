const express = require("express")
const cors = require("cors")

const app = express()

app.use(cors())
app.use(express.json())

const PORT = 3000

const rooms = {}

function generateCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    let code = ""
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)]
    }
    return code
}

function generateId() {
    return Math.random().toString(36).substring(2,10)
}

app.post("/create-room", (req,res)=>{

    const code = generateCode()

    const playerId = generateId()

    rooms[code] = {
        code,
        relayHost: req.headers.host.split(":")[0],
        relayPort: 5397,
        started:false,
        hostId: playerId,
        players:[
            {
                id: playerId,
                name:"Host",
                slot:1
            }
        ]
    }

    res.json({
        code,
        playerId,
        relayHost: rooms[code].relayHost,
        relayPort: rooms[code].relayPort
    })

})

app.post("/join-room",(req,res)=>{

    const { code , name } = req.body

    const room = rooms[code]

    if(!room) return res.status(404).json({error:"room not found"})

    if(room.players.length >=4)
        return res.status(400).json({error:"room full"})

    const playerId = generateId()

    const slot = room.players.length + 1

    const player = {
        id:playerId,
        name: name || "Player",
        slot
    }

    room.players.push(player)

    res.json({
        playerId,
        relayHost:room.relayHost,
        relayPort:room.relayPort
    })

})

app.get("/room/:code",(req,res)=>{

    const code = req.params.code

    const room = rooms[code]

    if(!room) return res.status(404).json({error:"room not found"})

    res.json(room)

})

app.post("/kick",(req,res)=>{

    const { code , hostId , playerId } = req.body

    const room = rooms[code]

    if(!room) return res.status(404).json({error:"room not found"})

    if(room.hostId !== hostId)
        return res.status(403).json({error:"not host"})

    room.players = room.players.filter(p=>p.id !== playerId)

    res.json({success:true})

})

app.post("/start",(req,res)=>{

    const { code , hostId } = req.body

    const room = rooms[code]

    if(!room) return res.status(404).json({error:"room not found"})

    if(room.hostId !== hostId)
        return res.status(403).json({error:"not host"})

    room.started = true

    res.json({started:true})

})

app.listen(PORT,()=>{
    console.log("Server running on port",PORT)
})