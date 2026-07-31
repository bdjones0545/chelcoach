import { Route, Routes } from "react-router-dom";
import { RequireAuth } from "./components/RequireAuth";
import Landing from "./screens/Landing";
import Upload from "./screens/Upload";
import PlayerConfirmation from "./screens/PlayerConfirmation";
import AnalysisStatus from "./screens/AnalysisStatus";
import AnalysisReport from "./screens/AnalysisReport";
import Processing from "./screens/Processing";
import Scorecard from "./screens/Scorecard";
import FilmPreview from "./screens/FilmPreview";
import Paywall from "./screens/Paywall";
import FilmRoom from "./screens/FilmRoom";
import Login from "./screens/Login";
import Signup from "./screens/Signup";
import ForgotPassword from "./screens/ForgotPassword";
import ResetPassword from "./screens/ResetPassword";

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      {/* Protected product surfaces (backend still enforces auth). */}
      <Route
        path="/upload"
        element={
          <RequireAuth>
            <Upload />
          </RequireAuth>
        }
      />
      <Route
        path="/player-confirmation"
        element={
          <RequireAuth>
            <PlayerConfirmation />
          </RequireAuth>
        }
      />
      <Route
        path="/analysis/:applicationRequestId"
        element={
          <RequireAuth>
            <AnalysisStatus />
          </RequireAuth>
        }
      />
      <Route
        path="/analysis/:applicationRequestId/confirm-player"
        element={
          <RequireAuth>
            <AnalysisStatus />
          </RequireAuth>
        }
      />
      <Route
        path="/analysis/:applicationRequestId/report"
        element={
          <RequireAuth>
            <AnalysisReport />
          </RequireAuth>
        }
      />
      <Route
        path="/analysis-status"
        element={
          <RequireAuth>
            <AnalysisStatus />
          </RequireAuth>
        }
      />

      {/* Mock conversion loop remains public for product demos */}
      <Route path="/processing" element={<Processing />} />
      <Route path="/scorecard" element={<Scorecard />} />
      <Route path="/film-preview" element={<FilmPreview />} />
      <Route path="/paywall" element={<Paywall />} />
      <Route path="/film-room" element={<FilmRoom />} />
      <Route path="*" element={<Landing />} />
    </Routes>
  );
}
