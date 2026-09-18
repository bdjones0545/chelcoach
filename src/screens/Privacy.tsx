import { PRIVACY_SECTIONS } from "../legal/content";
import LegalPage from "./LegalPage";

export default function Privacy() {
  return <LegalPage title="Privacy Policy" sections={PRIVACY_SECTIONS} />;
}
