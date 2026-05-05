import React, { createContext, useContext, useEffect, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
import { useAuthStore } from '../stores/authStore'
import { useFloorStore } from '../stores/floorStore'
import { useQueryClient } from '@tanstack/react-query'
import client from '../api/client'

const SocketContext = createContext<Socket | null>(null)

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const socketRef = useRef<Socket | null>(null)
  const user = useAuthStore((s) => s.user)
  const setResources = useFloorStore((s) => s.setResources)
  const qc = useQueryClient()

  useEffect(() => {
    if (!user) return

    const socket = io('/', { transports: ['websocket', 'polling'] })
    socketRef.current = socket

    const joinRooms = () => {
      socket.emit('join', { room: 'floor' })
      if (user.role === 'KITCHEN_STAFF' || user.role === 'MANAGER' || user.role === 'ADMIN') {
        socket.emit('join', { room: 'kitchen' })
      }
      if (user.role === 'BAR_STAFF' || user.role === 'MANAGER' || user.role === 'ADMIN') {
        socket.emit('join', { room: 'bar' })
      }
    }

    const refreshAll = () => {
      client.get('/resources').then((r) => {
        setResources(r.data)
        qc.setQueryData(['resources'], r.data)
      })
      qc.invalidateQueries({ queryKey: ['tickets-reopened'] })
      qc.invalidateQueries({ queryKey: ['tickets-pending-payment'] })
      qc.invalidateQueries({ queryKey: ['waiting-list'] })
    }

    socket.on('connect', () => {
      joinRooms()
      // Refresh all data on every (re)connect — events missed during a disconnect
      // (e.g. iOS backgrounding) are never replayed, so we need to re-sync.
      refreshAll()
    })

    socket.on('floor:update', () => {
      client.get('/resources').then((r) => {
        setResources(r.data)
        qc.setQueryData(['resources'], r.data)
      })
      qc.invalidateQueries({ queryKey: ['tickets-reopened'] })
      qc.invalidateQueries({ queryKey: ['tickets-pending-payment'] })
    })

    // Waiting list updated by any user action
    socket.on('waiting:update', () => {
      qc.invalidateQueries({ queryKey: ['waiting-list'] })
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [user])

  return React.createElement(SocketContext.Provider, { value: socketRef.current }, children)
}

export function useSocket() {
  return useContext(SocketContext)
}
