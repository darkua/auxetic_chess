import { createServer } from 'node:http'
import { Server } from 'socket.io'

const PORT = Number.parseInt(process.env.SIGNAL_PORT ?? '3007', 10)
const ROOM_GRACE_MS = 10 * 60 * 1000

/**
 * roomCode -> {
 *   hostSocketId,
 *   side,
 *   offerEnvelope?,
 *   guestSocketId?,
 *   hostCandidates: RTCIceCandidateInit[],
 *   guestCandidates: RTCIceCandidateInit[]
 * }
 */
const rooms = new Map()
const cleanupTimers = new Map()

const clearRoomCleanup = (roomCode) => {
  const existingTimeout = cleanupTimers.get(roomCode)
  if (existingTimeout) {
    clearTimeout(existingTimeout)
    cleanupTimers.delete(roomCode)
  }
}

const scheduleRoomCleanup = (roomCode) => {
  clearRoomCleanup(roomCode)
  const timeout = setTimeout(() => {
    const room = rooms.get(roomCode)
    if (!room) {
      cleanupTimers.delete(roomCode)
      return
    }
    if (!room.hostSocketId && !room.guestSocketId) {
      rooms.delete(roomCode)
    }
    cleanupTimers.delete(roomCode)
  }, ROOM_GRACE_MS)
  cleanupTimers.set(roomCode, timeout)
}

const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/signal/socket.io',
  cors: {
    origin: '*',
  },
})

io.on('connection', (socket) => {
  socket.on('host:create', ({ roomCode, side }, ack) => {
    if (!roomCode || (side !== 'w' && side !== 'b')) {
      ack({ ok: false, error: 'Invalid room or side.' })
      return
    }

    clearRoomCleanup(roomCode)
    rooms.set(roomCode, {
      hostSocketId: socket.id,
      side,
      offerEnvelope: null,
      guestSocketId: null,
      hostCandidates: [],
      guestCandidates: [],
    })
    socket.join(roomCode)
    ack({ ok: true })
  })

  socket.on('host:offer', ({ roomCode, envelope }, ack) => {
    const room = rooms.get(roomCode)
    if (!room || room.hostSocketId !== socket.id) {
      ack({ ok: false, error: 'Room not found.' })
      return
    }

    room.offerEnvelope = envelope
    rooms.set(roomCode, room)
    ack({ ok: true })
  })

  socket.on('guest:join', ({ roomCode }, ack) => {
    const room = rooms.get(roomCode)
    if (!room || !room.offerEnvelope) {
      ack({ ok: false, error: 'Room not ready.' })
      return
    }

    clearRoomCleanup(roomCode)
    room.guestSocketId = socket.id
    rooms.set(roomCode, room)
    socket.join(roomCode)
    ack({
      ok: true,
      data: {
        envelope: room.offerEnvelope,
        hostCandidates: room.hostCandidates ?? [],
      },
    })

    // If guest had sent any candidates before host joined fully, flush now.
    for (const candidate of room.guestCandidates ?? []) {
      io.to(room.hostSocketId).emit('host:candidate', { roomCode, candidate })
    }
  })

  socket.on('guest:answer', ({ roomCode, envelope }, ack) => {
    const room = rooms.get(roomCode)
    if (!room || !room.hostSocketId) {
      ack({ ok: false, error: 'Room not found.' })
      return
    }

    io.to(room.hostSocketId).emit('host:answer', {
      roomCode,
      answer: envelope.description,
    })
    ack({ ok: true })
  })

  socket.on('host:candidate', ({ roomCode, candidate }, ack) => {
    const room = rooms.get(roomCode)
    if (!room || room.hostSocketId !== socket.id) {
      ack({ ok: false, error: 'Room not ready.' })
      return
    }

    room.hostCandidates = [...(room.hostCandidates ?? []), candidate]
    rooms.set(roomCode, room)
    if (room.guestSocketId) {
      io.to(room.guestSocketId).emit('guest:candidate', { roomCode, candidate })
    }
    ack({ ok: true })
  })

  socket.on('guest:candidate', ({ roomCode, candidate }, ack) => {
    const room = rooms.get(roomCode)
    if (!room || room.guestSocketId !== socket.id || !room.hostSocketId) {
      ack({ ok: false, error: 'Room not ready.' })
      return
    }

    room.guestCandidates = [...(room.guestCandidates ?? []), candidate]
    rooms.set(roomCode, room)
    io.to(room.hostSocketId).emit('host:candidate', { roomCode, candidate })
    ack({ ok: true })
  })

  socket.on('disconnect', () => {
    for (const [roomCode, room] of rooms.entries()) {
      let changed = false
      if (room.hostSocketId === socket.id) {
        room.hostSocketId = null
        changed = true
      }
      if (room.guestSocketId === socket.id) {
        room.guestSocketId = null
        changed = true
      }

      if (changed) {
        rooms.set(roomCode, room)
        if (!room.hostSocketId && !room.guestSocketId) {
          scheduleRoomCleanup(roomCode)
        }
      }
    }
  })
})

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Signaling server running on http://localhost:${PORT}`)
})
