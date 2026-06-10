import type { SyllabusTemplate } from "./types";

export const STUDENT_ID = "student-demo-001";

export const FOCUS_GRACE_PERIOD_SECONDS = 5;

export const SYLLABUS_TEMPLATE: SyllabusTemplate = {
  subjects: [
    { id: "math", title: "Mathematics" },
    { id: "science", title: "Science" }
  ],
  chapters: [
    { id: "math-algebra", subjectId: "math", title: "Algebra" },
    { id: "math-geometry", subjectId: "math", title: "Geometry" },
    { id: "science-physics", subjectId: "science", title: "Physics" },
    { id: "science-bio", subjectId: "science", title: "Biology" }
  ],
  tasks: [
    {
      id: "task-linear-equations",
      subjectId: "math",
      chapterId: "math-algebra",
      title: "Solve 10 linear equations"
    },
    {
      id: "task-polynomials",
      subjectId: "math",
      chapterId: "math-algebra",
      title: "Finish polynomial worksheet"
    },
    {
      id: "task-triangles",
      subjectId: "math",
      chapterId: "math-geometry",
      title: "Revise triangle congruency"
    },
    {
      id: "task-angles",
      subjectId: "math",
      chapterId: "math-geometry",
      title: "Practice angle sum problems"
    },
    {
      id: "task-motion",
      subjectId: "science",
      chapterId: "science-physics",
      title: "Watch motion recap and notes"
    },
    {
      id: "task-force",
      subjectId: "science",
      chapterId: "science-physics",
      title: "Complete force quiz"
    },
    {
      id: "task-cells",
      subjectId: "science",
      chapterId: "science-bio",
      title: "Label plant and animal cells"
    },
    {
      id: "task-digestion",
      subjectId: "science",
      chapterId: "science-bio",
      title: "Summarize digestion chapter"
    }
  ]
};

