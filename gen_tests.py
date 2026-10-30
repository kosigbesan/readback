"""Build realistic test documents for ReadBack: a Q&A interview doc and a plain text one."""
import os
from docx import Document
from docx.shared import Pt

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests")
os.makedirs(OUT, exist_ok=True)

doc = Document()
doc.add_heading("Product Manager Interview, Round Two", level=1)
doc.add_paragraph(
    "This pack covers the questions that came up in the screen. Read the question, "
    "answer it out loud, then listen to the model answer and compare."
)
doc.add_heading("Behavioural", level=2)

qa = [
    ("Tell me about a time you shipped something that failed.",
     "Pick a real failure and own it. Name the decision you made, the signal you ignored, "
     "and what you changed afterwards. Interviewers are listening for whether you separate "
     "your judgement from your ego. Keep it under ninety seconds."),
    ("How do you decide what not to build?",
     "Start from the cost of saying yes. Every feature is a maintenance contract, a support "
     "burden, and a piece of surface area you have to defend in six months. I rank by "
     "reversibility first, then by how expensive the mistake is to undo."),
    ("Describe a time you disagreed with your manager.",
     "Explain the disagreement in terms of the outcome, not the personality. Say what you "
     "brought to the table, how you made the decision cheap to reverse, and what you did "
     "once the call went the other way. Committing after losing is the whole answer."),
    ("What is a metric you have moved, and how?",
     "State the baseline, the target, and the actual. Then spend most of the time on the "
     "mechanism, because that is the part that transfers to their problem."),
]
for q, a in qa:
    doc.add_paragraph(f"Q: {q}")
    doc.add_paragraph(f"A: {a}")

doc.add_heading("Case", level=2)
doc.add_paragraph("Q: Our activation rate dropped eight percent last quarter. Where do you start?")
doc.add_paragraph(
    "A: Segment before you diagnose. Split by platform, by acquisition channel, and by "
    "cohort, because a flat eight percent drop is almost never flat underneath. Then check "
    "whether the denominator moved, since a marketing change can look like a product change."
)
doc.save(os.path.join(OUT, "interview-qa.docx"))

plain = """Oxide Systems, Senior Backend Engineer

About the role
You will own the ingestion pipeline that carries about forty million events a day.
The team is six engineers and we deploy continuously.

What we are looking for
Strong Go or Rust. Comfort with Postgres at scale. Someone who has run an on call rotation
and has opinions about alerting that are not just "add more dashboards".

Interview process
A thirty minute screen, a two hour pairing session on a real bug, then a system design
round with two engineers and the hiring manager.
"""
open(os.path.join(OUT, "job-spec.txt"), "w", encoding="utf-8").write(plain)

print("wrote", os.listdir(OUT))

# --- a real text layer PDF, to exercise the pdf.js path and paragraph rebuild ---
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer

styles = getSampleStyleSheet()
H = ParagraphStyle("H", parent=styles["Heading1"], fontSize=18, spaceAfter=14)
H2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=13, spaceAfter=10)
B = ParagraphStyle("B", parent=styles["BodyText"], fontSize=10.5, leading=15, spaceAfter=9)

story = [Paragraph("Data Analyst Interview, Technical Round", H),
         Paragraph("Answer each question out loud before you listen to the model answer.", B)]
pdf_qa = [
    ("Walk me through how you would validate a dashboard nobody trusts.",
     "Start by finding where the numbers diverge from the source of truth, then rebuild one "
     "metric together with the stakeholder. Trust comes back through one reconciled number, "
     "not through a new dashboard."),
    ("How do you handle a stakeholder who wants a metric you think is misleading?",
     "Separate the decision they are trying to make from the metric they asked for. Offer the "
     "metric they want alongside the one that actually moves the decision, and let both live."),
    ("Explain a time you found a data quality bug that changed a decision.",
     "Name the bug, how long it had been live, who had seen the wrong number, and what you "
     "changed in the pipeline so it could not recur silently."),
]
for q, a in pdf_qa:
    story += [Paragraph(f"Q: {q}", H2), Paragraph(f"A: {a}", B), Spacer(1, 4)]
story += [Paragraph("Notes", H2),
          Paragraph("Bring one example where the correct answer was to do nothing.", B)]
SimpleDocTemplate(os.path.join(OUT, "analyst-qa.pdf"), pagesize=LETTER,
                  title="Data Analyst Interview").build(story)
print("pdf done")

