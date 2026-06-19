package main

import (
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
)

func main() {
	// Explicitly register WASM mime type for platforms where it might be missing
	_ = mime.AddExtensionType(".wasm", "application/wasm")

	// Root of static files
	staticDir := "./static"

	// Define routes
	http.Handle("/", http.FileServer(http.Dir(staticDir)))

	// API routes for local caches
	http.HandleFunc("/api/players", getPlayersHandler)
	http.HandleFunc("/api/commentary", getCommentaryHandler)

	// API proxies (optional but robust backup for CORS or if endpoints fail)
	http.HandleFunc("/api/teams", proxyHandler("https://worldcup26.ir/get/teams"))
	http.HandleFunc("/api/stadiums", proxyHandler("https://worldcup26.ir/get/stadiums"))
	http.HandleFunc("/api/games", proxyHandler("https://worldcup26.ir/get/games"))
	http.HandleFunc("/api/groups", proxyHandler("https://worldcup26.ir/get/groups"))

	port := "8080"
	fmt.Printf("Server starting on http://localhost:%s\n", port)
	err := http.ListenAndServe(":"+port, nil)
	if err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}

func getPlayersHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	homeDir, err := os.UserHomeDir()
	if err != nil {
		http.Error(w, `{"error": "Failed to get user home directory"}`, http.StatusInternalServerError)
		return
	}

	// Read Rouen cache path
	cachePath := filepath.Join(homeDir, "Library/Application Support/Rouen/worldcup_team_players_cache.json")
	
	// Fallback to check if it's there
	if _, err := os.Stat(cachePath); os.IsNotExist(err) {
		// Provide a default dummy if not exists, so it doesn't break
		w.Write([]byte(`{}`))
		return
	}

	data, err := os.ReadFile(cachePath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Failed to read cache file: %v"}`, err), http.StatusInternalServerError)
		return
	}

	w.Write(data)
}

func getCommentaryHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	homeDir, err := os.UserHomeDir()
	if err != nil {
		http.Error(w, `{"error": "Failed to get user home directory"}`, http.StatusInternalServerError)
		return
	}

	// Read Rouen cache path
	cachePath := filepath.Join(homeDir, "Library/Application Support/Rouen/worldcup_commentary_cache.json")

	if _, err := os.Stat(cachePath); os.IsNotExist(err) {
		w.Write([]byte(`{}`))
		return
	}

	data, err := os.ReadFile(cachePath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Failed to read cache file: %v"}`, err), http.StatusInternalServerError)
		return
	}

	w.Write(data)
}

func proxyHandler(url string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")

		resp, err := http.Get(url)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to fetch from proxy: %v"}`, err), http.StatusInternalServerError)
			return
		}
		defer resp.Body.Close()

		data, err := io.ReadAll(resp.Body)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to read proxy response: %v"}`, err), http.StatusInternalServerError)
			return
		}

		w.Write(data)
	}
}
