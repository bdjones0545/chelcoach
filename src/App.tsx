import { Route, Routes } from "react-router-dom";
import Landing from "./screens/Landing";
import Upload from "./screens/Upload";
import Processing from "./screens/Processing";
import Scorecard from "./screens/Scorecard";
import FilmPreview from "./screens/FilmPreview";
import Paywall from "./screens/Paywall";
import FilmRoom from "./screens/FilmRoom";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/upload" element={<Upload />} />
      <Route path="/processing" element={<Processing />} />
      <Route path="/scorecard" element={<Scorecard />} />
      <Route path="/film-preview" element={<FilmPreview />} />
      <Route path="/paywall" element={<Paywall />} />
      <Route path="/film-room" element={<FilmRoom />} />
      {/* Fallback → landing */}
      <Route path="*" element={<Landing />} />
    </Routes>
  );
}
