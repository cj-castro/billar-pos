import React from 'react'
import { IconWarning, IconRefresh } from './Icon'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught render error:', error, info)
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
          <div className="bg-zinc-800 rounded-2xl border border-red-700 p-8 max-w-md w-full space-y-4 text-center">
            <IconWarning className="w-10 h-10 mx-auto text-red-400" />
            <h1 className="text-xl font-bold text-red-400">Error inesperado</h1>
            <p className="text-zinc-400 text-sm">
              Algo salió mal en la interfaz. Por favor recarga la página.
            </p>
            {this.state.error && (
              <pre className="text-xs text-zinc-500 bg-zinc-900 rounded-lg p-3 text-left overflow-auto max-h-32">
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={this.handleReload}
              className="w-full py-3 bg-zinc-100 text-zinc-900 hover:bg-white rounded-xl font-bold flex items-center justify-center gap-2"
            >
              <IconRefresh className="w-4 h-4" />
              Recargar Página
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
