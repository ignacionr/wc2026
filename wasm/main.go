package main

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"syscall/js"
)

// Match matches the C++ struct
type Match struct {
	Group       string `json:"group"`
	HomeTeam    string `json:"home_team"`
	HomeCode    string `json:"home_code"`
	AwayTeam    string `json:"away_team"`
	AwayCode    string `json:"away_code"`
	HomeScore   int    `json:"home_score"`
	AwayScore   int    `json:"away_score"`
	Status      string `json:"status"` // COMPLETED, LIVE, UPCOMING
	DateStr     string `json:"date_str"`
	Venue       string `json:"venue"`
	TimeStr     string `json:"time_str"`
	HomeScorers string `json:"home_scorers"`
	AwayScorers string `json:"away_scorers"`
	StadiumID   string `json:"stadium_id"`
}

// GroupTeam matches the C++ struct
type GroupTeam struct {
	Name   string `json:"name"`
	Code   string `json:"code"`
	Played int    `json:"played"`
	Won    int    `json:"won"`
	Drawn  int    `json:"drawn"`
	Lost   int    `json:"lost"`
	GD     int    `json:"gd"`
	Points int    `json:"points"`
}

// PlayerInfo matches the C++ struct
type PlayerInfo struct {
	Name         string `json:"name"`
	PhotoURL     string `json:"photo_url"`
	Position     string `json:"position"`
	JerseyNumber int    `json:"jersey_number"`
	Comment      string `json:"comment"`
}

// LineupPlayer matches the C++ struct
type LineupPlayer struct {
	Name         string `json:"name"`
	Position     string `json:"position"`
	JerseyNumber int    `json:"jersey_number"`
}

// QAPair matches the C++ struct
type QAPair struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
}

// TeamData matches the structure in worldcup_team_players_cache.json
type TeamData struct {
	Players           []PlayerInfo   `json:"players"`
	Lineup            []LineupPlayer `json:"lineup"`
	QA                []QAPair       `json:"qa"`
	LastUpdatedEpoch  int64          `json:"last_updated_epoch"`
}

// SearchResult is the unified structure returned by search
type SearchResult struct {
	Type        string      `json:"type"` // "match", "team", "stadium", "player"
	Title       string      `json:"title"`
	Subtitle    string      `json:"subtitle"`
	Score       float64     `json:"score"` // Relevance score
	RefData     interface{} `json:"ref_data"`
}

func main() {
	c := make(chan struct{}, 0)

	// Register functions
	js.Global().Set("wasmSearchData", js.FuncOf(wasmSearchData))
	js.Global().Set("wasmCalculateStats", js.FuncOf(wasmCalculateStats))
	js.Global().Set("wasmFuzzyMatch", js.FuncOf(wasmFuzzyMatch))

	fmt.Println("WebAssembly module loaded successfully from Go!")
	<-c
}

// Simple fuzzy score helper (returns 0 to 1, higher is better)
func fuzzyScore(s, query string) float64 {
	s = strings.ToLower(s)
	query = strings.ToLower(query)

	if s == query {
		return 1.0
	}
	if strings.HasPrefix(s, query) {
		return 0.8 + 0.19*(float64(len(query))/float64(len(s)))
	}
	if strings.Contains(s, query) {
		return 0.5 + 0.29*(float64(len(query))/float64(len(s)))
	}

	// Simple edit distance or character matching overlap
	words := strings.Fields(query)
	matchedWords := 0
	for _, w := range words {
		if strings.Contains(s, w) {
			matchedWords++
		}
	}
	if len(words) > 0 && matchedWords > 0 {
		return 0.4 * (float64(matchedWords) / float64(len(words)))
	}

	return 0.0
}

func wasmFuzzyMatch(this js.Value, args []js.Value) interface{} {
	if len(args) < 2 {
		return 0.0
	}
	s := args[0].String()
	query := args[1].String()
	return fuzzyScore(s, query)
}

func wasmSearchData(this js.Value, args []js.Value) interface{} {
	if len(args) < 4 {
		return nil
	}

	query := strings.TrimSpace(args[0].String())
	matchesJSON := args[1].String()
	standingsJSON := args[2].String() // JSON of map[string][]GroupTeam
	playersJSON := args[3].String()   // JSON of map[string]TeamData

	var matches []Match
	var standings map[string][]GroupTeam
	var players map[string]TeamData

	_ = json.Unmarshal([]byte(matchesJSON), &matches)
	_ = json.Unmarshal([]byte(standingsJSON), &standings)
	_ = json.Unmarshal([]byte(playersJSON), &players)

	var results []SearchResult

	if query == "" {
		// Return empty results if query is empty
		jsonBytes, _ := json.Marshal(results)
		return string(jsonBytes)
	}

	// 1. Search Matches
	for _, m := range matches {
		score := 0.0
		score = math.Max(score, fuzzyScore(m.HomeTeam, query))
		score = math.Max(score, fuzzyScore(m.AwayTeam, query))
		score = math.Max(score, fuzzyScore(m.Venue, query))
		score = math.Max(score, fuzzyScore(m.Group, query))
		score = math.Max(score, fuzzyScore(m.HomeScorers, query)*0.8)
		score = math.Max(score, fuzzyScore(m.AwayScorers, query)*0.8)

		if score > 0.1 {
			results = append(results, SearchResult{
				Type:     "match",
				Title:    fmt.Sprintf("%s vs %s", m.HomeTeam, m.AwayTeam),
				Subtitle: fmt.Sprintf("Match (%s) - %s at %s", m.Group, m.Status, m.Venue),
				Score:    score,
				RefData:  m,
			})
		}
	}

	// 2. Search Teams in Standings
	for groupName, teams := range standings {
		for _, t := range teams {
			score := 0.0
			score = math.Max(score, fuzzyScore(t.Name, query))
			score = math.Max(score, fuzzyScore(t.Code, query))

			if score > 0.1 {
				results = append(results, SearchResult{
					Type:     "team",
					Title:    fmt.Sprintf("%s (%s)", t.Name, t.Code),
					Subtitle: fmt.Sprintf("Team in %s - PTS: %d, GD: %d", groupName, t.Points, t.GD),
					Score:    score,
					RefData:  t,
				})
			}
		}
	}

	// 3. Search Players
	for teamCode, teamData := range players {
		for _, p := range teamData.Players {
			score := 0.0
			score = math.Max(score, fuzzyScore(p.Name, query))
			score = math.Max(score, fuzzyScore(p.Position, query)*0.5) // Lower weight for positions
			score = math.Max(score, fuzzyScore(p.Comment, query)*0.4)  // Lower weight for comments

			if score > 0.1 {
				results = append(results, SearchResult{
					Type:     "player",
					Title:    p.Name,
					Subtitle: fmt.Sprintf("Player (%s, #%d) - %s", p.Position, p.JerseyNumber, teamCode),
					Score:    score,
					RefData:  p,
				})
			}
		}
	}

	// Sort results by score descending
	sort.Slice(results, func(i, j int) bool {
		return results[i].Score > results[j].Score
	})

	// Limit to top 15 results
	if len(results) > 15 {
		results = results[:15]
	}

	jsonBytes, err := json.Marshal(results)
	if err != nil {
		return fmt.Sprintf(`{"error": "%s"}`, err.Error())
	}

	return string(jsonBytes)
}

func wasmCalculateStats(this js.Value, args []js.Value) interface{} {
	if len(args) < 1 {
		return nil
	}

	matchesJSON := args[0].String()
	var matches []Match
	_ = json.Unmarshal([]byte(matchesJSON), &matches)

	totalGoals := 0
	completed := 0
	live := 0
	upcoming := 0
	goalsPerMatch := 0.0

	teamGoals := make(map[string]int)
	teamMatches := make(map[string]int)

	for _, m := range matches {
		switch m.Status {
		case "COMPLETED":
			completed++
			goals := m.HomeScore + m.AwayScore
			totalGoals += goals
			teamGoals[m.HomeTeam] += m.HomeScore
			teamGoals[m.AwayTeam] += m.AwayScore
			teamMatches[m.HomeTeam]++
			teamMatches[m.AwayTeam]++
		case "LIVE":
			live++
			goals := m.HomeScore + m.AwayScore
			totalGoals += goals
			teamGoals[m.HomeTeam] += m.HomeScore
			teamGoals[m.AwayTeam] += m.AwayScore
			teamMatches[m.HomeTeam]++
			teamMatches[m.AwayTeam]++
		case "UPCOMING":
			upcoming++
		}
	}

	playedCount := completed + live
	if playedCount > 0 {
		goalsPerMatch = float64(totalGoals) / float64(playedCount)
	}

	// Find top scoring team
	topTeam := "N/A"
	maxGoals := -1
	for t, g := range teamGoals {
		if g > maxGoals {
			maxGoals = g
			topTeam = t
		}
	}

	stats := map[string]interface{}{
		"total_goals":      totalGoals,
		"played_matches":   playedCount,
		"completed":        completed,
		"live":             live,
		"upcoming":         upcoming,
		"goals_per_match":  math.Round(goalsPerMatch*100) / 100,
		"top_scoring_team": fmt.Sprintf("%s (%d goals)", topTeam, maxGoals),
	}

	jsonBytes, _ := json.Marshal(stats)
	return string(jsonBytes)
}
