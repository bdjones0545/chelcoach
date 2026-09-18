import { TERMS_SECTIONS } from "../legal/content";
import LegalPage from "./LegalPage";

export default function Terms() {
  return <LegalPage title="Terms of Service" sections={TERMS_SECTIONS} />;
}
