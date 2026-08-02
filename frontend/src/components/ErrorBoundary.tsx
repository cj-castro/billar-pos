import React from 'react'

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
        <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
          <div className="bg-slate-800 rounded-2xl border border-red-700 p-8 max-w-md w-full space-y-4 text-center">
            <p className="text-4xl">⚠️</p>
            <h1 className="text-xl font-bold text-red-400">Error inesperado</h1>
            <p className="text-slate-400 text-sm">
              Algo salió mal en la interfaz. Por favor recarga la página.
            </p>
            {this.state.error && (
              <pre className="text-xs text-slate-500 bg-slate-900 rounded-lg p-3 text-left overflow-auto max-h-32">
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={this.handleReload}
              className="w-full py-3 bg-blue-600 hover:bg-blue-500 rounded-xl font-bold"
            >
              🔄 Recargar Página
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
