import { useState } from 'react'
import './App.css'

export default function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="app">
      <header>
        <h1>👁 Claude Eyes Pilot</h1>
        <p className="lead">
          Pedile a Claude Code en esta carpeta que te cambie esto.
          Cada edit dispara una captura y Claude la ve en el siguiente turn.
        </p>
      </header>

      <main>
        <div className="card">
          <h2>Botón de prueba</h2>
          <button className="primary" onClick={() => setCount(c => c + 1)}>
            🔥 Click me ({count})
          </button>
          <p className="hint">Pedile a Claude: "pintalo de rojo y agregale un ícono"</p>
        </div>

        <div className="card">
          <h2>Hero text</h2>
          <p className="hero">
            La realidad es que la mayoría de la gente no lee.
          </p>
          <p className="hint">Pedile a Claude: "hacelo más bold y centralo"</p>
        </div>

        <div className="card">
          <h2>Layout</h2>
          <div className="row">
            <div className="box">A</div>
            <div className="box">B</div>
            <div className="box">C</div>
          </div>
          <p className="hint">Pedile a Claude: "convertí esto en un grid de 2x2"</p>
        </div>
      </main>

      <footer>
        <small>
          file: <code>src/App.tsx</code> · save y ver el frame en <code>.claude/eyes/last.png</code>
        </small>
      </footer>
    </div>
  )
}
