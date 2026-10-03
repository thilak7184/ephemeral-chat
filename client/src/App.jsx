import { Component } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import HomePage from './pages/HomePage.jsx';
import RoomPage from './pages/RoomPage.jsx';

class ErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('Application rendering failed:', error);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="room-page state-page">
          <section className="state-card">
            <p className="eyebrow">EPHEMERAL CHAT</p>
            <h1>Something went wrong.</h1>
            <p>Your conversation is still private. Reload the app to continue.</p>
            <button
              className="button button-primary state-action"
              type="button"
              onClick={() => window.location.assign('/')}
            >
              Reload app
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/r/:roomCode" element={<RoomPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
